import { type InputHTMLAttributes, type KeyboardEvent, useEffect, useRef, useState } from 'react';

export interface NumberDraftState {
  draft: string;
  lastValid: number;
}

export function editNumberDraft(state: NumberDraftState, draft: string): NumberDraftState {
  if (draft.trim() === '') return { ...state, draft };
  const parsed = Number(draft);
  return Number.isFinite(parsed) ? { draft, lastValid: parsed } : { ...state, draft };
}

export function finishNumberDraft(
  state: NumberDraftState,
  min?: number,
  max?: number,
): NumberDraftState {
  const parsed = state.draft.trim() === '' ? state.lastValid : Number(state.draft);
  const safeValue = Number.isFinite(parsed) ? parsed : state.lastValid;
  const clamped = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? -Infinity, safeValue));
  return { draft: String(clamped), lastValid: clamped };
}

type NumberDraftInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'min' | 'max'
> & {
  value: number;
  min?: number;
  max?: number;
  onValueChange: (value: number) => void;
};

export function NumberDraftInput({
  value,
  min,
  max,
  onValueChange,
  onBlur,
  onFocus,
  onKeyDown,
  ...inputProps
}: NumberDraftInputProps) {
  const [state, setState] = useState<NumberDraftState>({
    draft: String(value),
    lastValid: value,
  });
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setState({ draft: String(value), lastValid: value });
  }, [value]);

  const finish = () => {
    const next = finishNumberDraft(state, min, max);
    setState(next);
    onValueChange(next.lastValid);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== 'Enter') return;
    event.currentTarget.blur();
  };

  return (
    <input
      {...inputProps}
      type="number"
      min={min}
      max={max}
      value={state.draft}
      onChange={(event) => {
        const next = editNumberDraft(state, event.target.value);
        setState(next);
        if (event.target.value.trim() !== '' && Number.isFinite(Number(event.target.value))) {
          onValueChange(Number(event.target.value));
        }
      }}
      onFocus={(event) => {
        focused.current = true;
        onFocus?.(event);
      }}
      onBlur={(event) => {
        focused.current = false;
        finish();
        onBlur?.(event);
      }}
      onKeyDown={handleKeyDown}
    />
  );
}
