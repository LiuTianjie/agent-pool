import type {
  DatasetSource,
  RequestedAgent,
  TaskCategory,
  WalletSummary,
} from '@agent-pool/shared';
import { DATASET_UNIT_MAX, INLINE_UNIT_MAX } from '@agent-pool/shared';
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
import { useI18n, type MessageKey } from '../i18n';
import { api, ApiError } from '../lib/api';
import { capacityReason, credits, formatInteger, fullDateTime } from '../lib/format';
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

const CATEGORY_KEYS: Array<{ value: TaskCategory; label: MessageKey }> = [
  { value: 'text', label: 'publish.categoryText' },
  { value: 'data', label: 'publish.categoryData' },
  { value: 'coding', label: 'publish.categoryCoding' },
  { value: 'research', label: 'publish.categoryResearch' },
  { value: 'math', label: 'publish.categoryMath' },
  { value: 'vision', label: 'publish.categoryVision' },
  { value: 'other', label: 'publish.categoryOther' },
];

const STEP_KEYS = [
  { id: 1, label: 'publish.stepContract' },
  { id: 2, label: 'publish.stepTerms' },
  { id: 3, label: 'publish.stepConfirm' },
] as const;

const ACCEPTANCE_CRITERIA: Record<AcceptanceMode, string> = {
  non_empty: '结果非空',
  hidden_exact: '与托管答案一致',
  schema: 'JSON Schema',
  schema_and_hidden_exact: 'Schema + 托管答案',
  manual: '人工确认',
  webhook: '回调回执',
};

const ACCEPTANCE_KEYS: Record<AcceptanceMode, MessageKey> = {
  non_empty: 'publish.acceptNonEmpty',
  hidden_exact: 'publish.acceptHiddenExact',
  schema: 'publish.acceptSchema',
  schema_and_hidden_exact: 'publish.acceptSchemaAndHidden',
  manual: 'publish.acceptManual',
  webhook: 'publish.acceptWebhook',
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

export function PublishPage() {
  const { t } = useI18n();
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
        setError(requestError instanceof ApiError ? requestError.message : t('publish.loadError'));
      })
      .finally(() => setLoading(false));
  }, [draft, t]);

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
    source === 'work' && workPreview ? workPreview.title : title.trim() || t('common.untitledTask');
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
        setParseError(t('publish.minUnits'));
        return null;
      }
      if (parsed.length > INLINE_UNIT_MAX) {
        setParseError(t('publish.tooManyPaste'));
        return null;
      }
      setUnits(parsed);
      setParseError(null);
      return parsed;
    } catch (parseIssue) {
      setParseError(parseIssue instanceof Error ? parseIssue.message : t('publish.parseFailed'));
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
      criteria: [ACCEPTANCE_CRITERIA[acceptanceMode]],
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
      return voidError(t('publish.workHttps'));
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
        return voidError(t('publish.notWorkPackage'));
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
        requestError instanceof ApiError ? requestError.message : t('publish.workReadFailed'),
      );
    } finally {
      setChecking(false);
    }
  };

  const probeHttps = async (): Promise<boolean> => {
    if (!isHttpsDatasetUrl(datasetUrl)) {
      return voidError(t('publish.jsonlHttps'));
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
      const message =
        requestError instanceof ApiError ? requestError.message : t('publish.urlCheckFailed');
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
          return voidError(t('publish.confirmWork'));
        }
      } else {
        if (title.trim().length < 3) return voidError(t('publish.titleMin'));
        if (goal.trim().length < 8) return voidError(t('publish.goalRequired'));
        if (inputDescription.trim().length < 8) return voidError(t('publish.inputRequired'));
        if (outputDescription.trim().length < 8) return voidError(t('publish.outputRequired'));
        if (!examples[0]?.input.trim() || !examples[0]?.output.trim()) {
          return voidError(t('publish.exampleRequired'));
        }
        if (!requestedModel.trim()) return voidError(t('publish.modelRequired'));
        if (acceptanceMode === 'schema' || acceptanceMode === 'schema_and_hidden_exact') {
          if (deliveryFormat !== 'json') return voidError(t('publish.schemaNeedsJson'));
          if (!schemaState.value)
            return voidError(schemaState.error || t('publish.schemaRequired'));
        }
        if (deliveryTarget === 'webhook' && !isHttpsWebhook(webhookUrl)) {
          return voidError(t('publish.webhookHttps'));
        }
        if (source === 'https' && !httpsReady) return voidError(t('publish.checkJsonlFirst'));
        if (source === 'inline') {
          const parsed = parseCurrentUnits();
          if (!parsed) return false;
          if (acceptanceMode === 'hidden_exact' || acceptanceMode === 'schema_and_hidden_exact') {
            if (parsed.some((unit) => unit.expectedOutput === undefined)) {
              return voidError(t('publish.expectedOutputRequired'));
            }
          }
          if (deliveryTarget === 'webhook') {
            const issues = unitReferenceIssues(parsed);
            if (issues.length) return voidError(issues.join(' · '));
          }
        }
      }
    }
    if (step === 2) {
      if (!unitCount) return voidError(t('publish.confirmData'));
      if (requiredConcurrency < 1 || requiredConcurrency > unitCount) {
        return voidError(t('publish.concurrencyRange'));
      }
      if (maxUnitSeconds < 10 || maxUnitSeconds > 3600) {
        return voidError(t('publish.timeoutRange'));
      }
      if (rewardPerUnit < 1 || rewardPerUnit > 1_000_000) {
        return voidError(t('publish.rewardRange'));
      }
      if (launchMode === 'pilot' && (pilotUnits < 1 || pilotUnits > Math.min(3, unitCount))) {
        return voidError(t('publish.pilotRange'));
      }
      const deadlineTime = new Date(deadlineAt).getTime();
      if (!Number.isFinite(deadlineTime) || deadlineTime <= Date.now() + 10_000) {
        return voidError(t('publish.deadlineSoon'));
      }
      if (budget > (wallet?.purchasedAvailable || 0)) {
        return voidError(t('publish.notEnoughCredits'));
      }
    }
    if (step === 3 && budget > (wallet?.purchasedAvailable || 0)) {
      return voidError(t('publish.notEnoughCredits'));
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
            ? t('publish.quoteFeasible', { count: nextQuote.availableConcurrency })
            : nextQuote.reasons.map((reason) => capacityReason(reason)).join(' · ') ||
                t('publish.quoteFail'),
        );
      } catch {
        setQuoteNote(t('publish.quoteUnavailable'));
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
      setError(
        requestError instanceof ApiError ? requestError.message : t('publish.publishFailed'),
      );
    } finally {
      setPublishing(false);
    }
  };

  if (loading && !wallet) return <LoadingState label={t('common.loading')} />;

  return (
    <div className="page publish-page capsule-publish-page contract-publish-page">
      <DocumentTitle title={t('publish.title')} />
      <PageHeader
        eyebrow={t('publish.title')}
        title={t('publish.heading')}
        description={t('publish.description')}
      />

      <nav className="wizard-steps" aria-label={t('publish.stepsAria')}>
        {STEP_KEYS.map((item) => (
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
            {t(item.label)}
          </button>
        ))}
      </nav>

      {error ? <InlineError message={error} /> : null}

      <section className="wizard-panel publish-workbench contract-desk">
        {step === 1 ? (
          <div className="contract-stage">
            <article className="contract-primary">
              <header>
                <span className="contract-kicker">{t('publish.contractKicker')}</span>
                <h2>{t('publish.contractTitle')}</h2>
                <p>{t('publish.contractLead')}</p>
              </header>

              <label className="field contract-url-field">
                <span>{t('publish.workUrl')}</span>
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
                  {checking && source === 'work' ? t('publish.reading') : t('publish.readContract')}
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
                  {t('publish.fillExample')}
                </button>
                <span>{t('publish.httpsHint')}</span>
              </div>

              {workPreview && workPreview.url === workUrl.trim() ? (
                <div className="contract-preview" data-ready="true">
                  <div>
                    <strong>{workPreview.title}</strong>
                    <p>{workPreview.publicSummary}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>{t('publish.previewCount')}</dt>
                      <dd>{formatInteger(workPreview.totalUnits)}</dd>
                    </div>
                    <div>
                      <dt>{t('publish.previewRun')}</dt>
                      <dd>
                        {workPreview.adapter} / {workPreview.model}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('publish.previewAccept')}</dt>
                      <dd>{t(ACCEPTANCE_KEYS[workPreview.acceptance])}</dd>
                    </div>
                    <div>
                      <dt>{t('publish.previewPrompts')}</dt>
                      <dd>{workPreview.unitsHost}</dd>
                    </div>
                    <div>
                      <dt>{t('publish.previewAnswers')}</dt>
                      <dd>{workPreview.answersHost || t('publish.noHostedAnswer')}</dd>
                    </div>
                    <div>
                      <dt>{t('publish.previewManifest')}</dt>
                      <dd>{workPreview.urlHost}</dd>
                    </div>
                  </dl>
                  <p className="contract-seal">
                    <LockKeyhole aria-hidden="true" />
                    {t('publish.sealIndex')}
                  </p>
                </div>
              ) : (
                <div className="contract-preview">
                  <p>{t('publish.previewEmpty')}</p>
                </div>
              )}
            </article>

            <details className="contract-alt">
              <summary>{t('publish.altSummary')}</summary>
              <div className="contract-alt-body">
                <div className="delivery-target-grid">
                  <button
                    type="button"
                    className={source === 'https' ? 'delivery-target active' : 'delivery-target'}
                    onClick={() => setSource('https')}
                  >
                    <FileJson2 aria-hidden="true" />
                    <span>
                      <strong>{t('publish.httpsTitle')}</strong>
                      <small>{t('publish.httpsDetail')}</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={source === 'inline' ? 'delivery-target active' : 'delivery-target'}
                    onClick={() => setSource('inline')}
                  >
                    <Upload aria-hidden="true" />
                    <span>
                      <strong>{t('publish.pasteTitle')}</strong>
                      <small>{t('publish.pasteDetail')}</small>
                    </span>
                  </button>
                </div>

                {source !== 'work' ? (
                  <div className="contract-editor">
                    <label className="field capsule-title-field">
                      <span>{t('publish.taskName')}</span>
                      <input
                        value={title}
                        maxLength={120}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder={t('publish.taskNamePlaceholder')}
                      />
                    </label>
                    <fieldset className="field">
                      <legend>{t('publish.typeLegend')}</legend>
                      <div className="chip-row">
                        {CATEGORY_KEYS.map((item) => (
                          <button
                            key={item.value}
                            type="button"
                            className={category === item.value ? 'chip chip-active' : 'chip'}
                            onClick={() => setCategory(item.value)}
                          >
                            {t(item.label)}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <label className="field">
                      <span>{t('publish.goal')}</span>
                      <textarea
                        rows={3}
                        value={goal}
                        onChange={(event) => setGoal(event.target.value)}
                        placeholder={t('publish.goalPlaceholder')}
                      />
                    </label>
                    <div className="contract-pair">
                      <label className="field">
                        <span>{t('publish.eachInput')}</span>
                        <textarea
                          rows={3}
                          value={inputDescription}
                          onChange={(event) => setInputDescription(event.target.value)}
                        />
                      </label>
                      <label className="field">
                        <span>{t('publish.expectedOutput')}</span>
                        <textarea
                          rows={3}
                          value={outputDescription}
                          onChange={(event) => setOutputDescription(event.target.value)}
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>{t('publish.constraints')}</span>
                      <input
                        value={constraintsRaw}
                        onChange={(event) => setConstraintsRaw(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>{t('publish.exampleIn')}</span>
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
                      <span>{t('publish.exampleOut')}</span>
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
                        <span>{t('publish.adapter')}</span>
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
                        <span>{t('publish.exactModel')}</span>
                        <input
                          list="publish-models"
                          value={requestedModel}
                          onChange={(event) => setRequestedModel(event.target.value)}
                          placeholder={t('publish.exactModelPlaceholder')}
                        />
                        <datalist id="publish-models">
                          {currentModels.map((model) => (
                            <option key={model} value={model} />
                          ))}
                        </datalist>
                      </label>
                    </div>
                    <fieldset className="field">
                      <legend>{t('publish.howDone')}</legend>
                      <div className="chip-row">
                        {(
                          [
                            ['non_empty', 'publish.acceptNonEmpty'],
                            ['hidden_exact', 'publish.acceptHidden'],
                            ['manual', 'publish.acceptManual'],
                            ['schema', 'publish.acceptSchema'],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            className={acceptanceMode === value ? 'chip chip-active' : 'chip'}
                            onClick={() => setAcceptanceMode(value)}
                          >
                            {t(label)}
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
                        <span>{t('publish.jsonlUrl')}</span>
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
                          {checking ? t('publish.checking') : t('publish.checkFile')}
                        </button>
                        {httpsReady ? (
                          <small>
                            {t('publish.unitCountHost', {
                              count: formatInteger(remoteUnitCount),
                              host: datasetHost ?? '',
                            })}
                          </small>
                        ) : null}
                      </label>
                    ) : (
                      <label className="field">
                        <span>{t('publish.unitBody')}</span>
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
                            {t('publish.lineEach')}
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
                <span className="contract-kicker">{t('publish.marketKicker')}</span>
                <h2>{t('publish.marketTitle')}</h2>
                <p>{t('publish.marketLead')}</p>
              </header>
              <div className="contract-market">
                <label className="field">
                  <span>{t('publish.rewardEach')}</span>
                  <NumberDraftInput
                    value={rewardPerUnit}
                    min={1}
                    max={1_000_000}
                    onValueChange={setRewardPerUnit}
                  />
                </label>
                <label className="field">
                  <span>{t('publish.concurrentClaim')}</span>
                  <NumberDraftInput
                    value={requiredConcurrency}
                    min={1}
                    max={Math.max(1, unitCount)}
                    onValueChange={setRequiredConcurrency}
                  />
                </label>
                <label className="field">
                  <span>{t('publish.unitTimeout')}</span>
                  <NumberDraftInput
                    value={maxUnitSeconds}
                    min={10}
                    max={3600}
                    onValueChange={setMaxUnitSeconds}
                  />
                </label>
                <label className="field">
                  <span>{t('publish.deadline')}</span>
                  <input
                    type="datetime-local"
                    value={deadlineAt}
                    onChange={(event) => setDeadlineAt(event.target.value)}
                  />
                </label>
              </div>
              <fieldset className="field">
                <legend>{t('publish.launchLegend')}</legend>
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
                      <strong>{t('publish.pilotTitle')}</strong>
                      <small>{t('publish.pilotDetail')}</small>
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
                      <strong>{t('publish.immediateTitle')}</strong>
                      <small>{t('publish.immediateDetail')}</small>
                    </span>
                  </button>
                </div>
              </fieldset>
              {launchMode === 'pilot' ? (
                <label className="field">
                  <span>{t('publish.pilotCount')}</span>
                  <NumberDraftInput
                    value={pilotUnits}
                    min={1}
                    max={Math.min(3, Math.max(1, unitCount))}
                    onValueChange={setPilotUnits}
                  />
                </label>
              ) : null}
              <p className={`contract-budget${budgetShort ? ' contract-budget-short' : ''}`}>
                {t('publish.willLock')} <strong>{credits(budget)}</strong>
                {wallet
                  ? ` · ${t('publish.available', { amount: credits(wallet.purchasedAvailable) })}`
                  : null}
                {budgetShort ? (
                  <>
                    {' '}
                    · {t('publish.shortPublish')}
                    <Link to="/app/wallet">{t('publish.goTopUp')}</Link>
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
                <span className="contract-kicker">{t('publish.confirmKicker')}</span>
                <h2>{effectiveTitle}</h2>
                <p>
                  {t('publish.confirmMeta', {
                    count: formatInteger(unitCount),
                    agent: effectiveAgent,
                    model: effectiveModel,
                    acceptance: t(ACCEPTANCE_KEYS[effectiveAcceptance]),
                  })}
                </p>
              </header>
              <dl className="contract-confirm">
                <div>
                  <dt>{t('publish.data')}</dt>
                  <dd>
                    {source === 'work'
                      ? t('publish.dataWork', { host: workPreview?.urlHost ?? '' })
                      : source === 'https'
                        ? t('publish.dataJsonl', { host: datasetHost ?? '' })
                        : t('publish.dataInline')}
                  </dd>
                </div>
                <div>
                  <dt>{t('publish.unitPrice')}</dt>
                  <dd>{credits(rewardPerUnit)}</dd>
                </div>
                <div>
                  <dt>{t('publish.locked')}</dt>
                  <dd>{credits(budget)}</dd>
                </div>
                <div>
                  <dt>{t('publish.concurrent')}</dt>
                  <dd>{requiredConcurrency}</dd>
                </div>
                <div>
                  <dt>{t('publish.deadlineLabel')}</dt>
                  <dd>{fullDateTime(deadlineIso(deadlineAt))}</dd>
                </div>
                <div>
                  <dt>{t('publish.launch')}</dt>
                  <dd>
                    {launchMode === 'pilot'
                      ? t('publish.launchPilot', { count: pilotUnits })
                      : t('publish.launchAll')}
                  </dd>
                </div>
              </dl>
              {quoteNote ? <p className="contract-quote">{quoteNote}</p> : null}
              {budgetShort ? (
                <p className="contract-budget contract-budget-short">
                  {t('publish.shortBy', { amount: credits(budget - purchasedAvailable) })}
                  <Link to="/app/wallet">{t('publish.goTopUp')}</Link>
                </p>
              ) : null}
              <p className="contract-seal">
                <LockKeyhole aria-hidden="true" />
                {t('publish.sealNoDispatch')}
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
                <ArrowLeft aria-hidden="true" /> {t('publish.back')}
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
                {t('publish.next')} <ArrowRight aria-hidden="true" />
              </button>
            ) : (
              <button
                className="button button-primary"
                type="button"
                disabled={publishing || budgetShort}
                onClick={() => void publish()}
              >
                {publishing
                  ? t('publish.publishing')
                  : t('publish.lockAndPublish', { amount: credits(budget) })}
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
