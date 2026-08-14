import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  criticalChanges,
  validateSettings,
  DEFAULT_SETTINGS,
  SETTINGS_PROBLEM_MESSAGES,
  type AppSettings,
  type CriticalSetting,
} from '@/domain/settings';
import { observeSettings, saveSettings } from '@/services/settings.service';

export type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed';

export interface SettingsDraft {
  readonly stored: AppSettings;
  readonly values: AppSettings;
  readonly set: <K extends keyof AppSettings>(field: K, value: AppSettings[K]) => void;
  readonly saveState: SaveState;
  readonly problems: readonly string[];
  /** Which critical settings this draft would change. Empty when none. */
  readonly critical: readonly CriticalSetting[];
  readonly error: string | null;
  readonly save: () => Promise<void>;
  readonly discard: () => void;
}

/**
 * The settings draft, shared by every panel that edits them.
 *
 * ## Nothing saves itself
 *
 * A financial setting must never be written by a keystroke. The draft is held
 * locally and the panel shows **Unsaved changes** until the owner presses save,
 * because a VAT rate that changed because somebody tabbed through a field is a
 * change nobody decided to make. (§33)
 *
 * ## A live update never clobbers typing
 *
 * The draft is `null` until something is edited, and `values` falls back to
 * whatever the listener last delivered. So a change made on another device
 * appears immediately when nothing is being edited, and is ignored while it is
 * — rather than overwriting a half-typed rate.
 */
export function useSettingsDraft(): SettingsDraft {
  const { t } = useT();
  const { principal, state } = useAuth();

  const [stored, setStored] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('clean');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return observeSettings(setStored, (caught) => setError(caught.message));
  }, []);

  const values = draft ?? stored;

  const set = useCallback(
    <K extends keyof AppSettings>(field: K, value: AppSettings[K]) => {
      setDraft((current) => ({ ...(current ?? stored), [field]: value }));
      setSaveState('dirty');
      setError(null);
    },
    [stored],
  );

  const problems = useMemo(
    () => validateSettings(values).map((problem) => SETTINGS_PROBLEM_MESSAGES[problem]),
    [values],
  );

  const critical = useMemo(() => criticalChanges(stored, values), [stored, values]);

  const save = useCallback(async () => {
    if (principal === null || draft === null) return;

    if (validateSettings(draft).length > 0) {
      setSaveState('failed');
      return;
    }

    setSaveState('saving');
    setError(null);

    try {
      const outcome = await saveSettings({
        settings: draft,
        actor: {
          uid: principal.uid,
          name: state.status === 'signed-in' ? state.session.name : '',
          role: principal.role,
        },
      });

      if (outcome.status === 'failed') {
        setSaveState('failed');
        setError(outcome.error.message);
        return;
      }

      setDraft(null);
      setSaveState('saved');
    } catch (caught) {
      setSaveState('failed');
      setError(caught instanceof Error ? caught.message : t('error.loadFailed'));
    }
  }, [draft, principal, state, t]);

  const discard = useCallback(() => {
    setDraft(null);
    setSaveState('clean');
    setError(null);
  }, []);

  return { stored, values, set, saveState, problems, critical, error, save, discard };
}
