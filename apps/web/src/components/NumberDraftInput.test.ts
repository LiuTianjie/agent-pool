import { describe, expect, it } from 'vitest';
import { editNumberDraft, finishNumberDraft, type NumberDraftState } from './NumberDraftInput';

describe('NumberDraftInput draft editing', () => {
  it('stays empty while deleting, accepts a replacement, and only clamps on finish', () => {
    let state: NumberDraftState = { draft: '20', lastValid: 20 };

    state = editNumberDraft(state, '');
    expect(state).toEqual({ draft: '', lastValid: 20 });

    state = editNumberDraft(state, '500');
    expect(state).toEqual({ draft: '500', lastValid: 500 });

    state = finishNumberDraft(state, 1, 100);
    expect(state).toEqual({ draft: '100', lastValid: 100 });
  });

  it('reverts an empty draft to the last valid value on finish', () => {
    const state = finishNumberDraft({ draft: '', lastValid: 120 }, 10, 3_600);
    expect(state).toEqual({ draft: '120', lastValid: 120 });
  });
});
