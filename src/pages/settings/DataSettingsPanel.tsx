import { useState } from 'react';

import { Alert, Button } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { useConnectivity } from '@/hooks/useConnectivity';
import { toFriendlyError } from '@/domain/firebase-errors';
import { CURRENT_SCHEMA_VERSION, type BackupProblem } from '@/domain/backup';
import {
  downloadBackup,
  exportAllData,
  importBackup,
  inspectBackup,
  type InspectedBackup,
} from '@/services/backup.service';
import { readEnvironment } from '@/config/env';

/**
 * Backup and restore.
 *
 * Two operations with very different weights, and the screen treats them that
 * way. Export is a button. Restore is: choose a file, see exactly what it would
 * do, then confirm — and nothing is written until that confirmation.
 */
export function DataSettingsPanel() {
  const { t } = useT();
  const { principal, state } = useAuth();
  const { isOffline } = useConnectivity();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [inspected, setInspected] = useState<InspectedBackup | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const environment = readEnvironment();
  const env = environment.status === 'ok' ? environment.env : null;

  const actor =
    principal === null
      ? null
      : {
          uid: principal.uid,
          name: state.status === 'signed-in' ? state.session.name : '',
          role: principal.role,
        };

  async function handleExport(): Promise<void> {
    if (busy || env === null) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const result = await exportAllData({
        projectId: env.firebase.projectId,
        environment: env.appEnv,
        applicationVersion: __APP_VERSION__,
        onProgress: (name) => setProgress(name),
      });

      /*
       * The file is handed over first, and only then is success reported. A
       * "backup successful" message printed before the file exists is exactly
       * the claim §29 forbids.
       */
      downloadBackup(result);

      setNotice(
        `${t('backup.exported')} ${String(result.totalRecords)} ${t('backup.records')}.`,
      );
    } catch (caught) {
      setError(toFriendlyError(caught).message);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function handleChoose(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setInspected(null);

    try {
      setInspected(await inspectBackup(await file.text()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : toFriendlyError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(): Promise<void> {
    if (inspected === null || actor === null || busy) return;

    setBusy(true);
    setError(null);

    try {
      const result = await importBackup({
        file: inspected.file,
        actor,
        onProgress: (entry) =>
          setProgress(`${entry.collection} — ${String(entry.written)}/${String(entry.total)}`),
      });

      setNotice(`${t('backup.imported')} ${String(result.written)} ${t('backup.records')}.`);
      setInspected(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : toFriendlyError(caught).message);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  const differentProject =
    inspected !== null && env !== null && inspected.file.projectId !== env.firebase.projectId;

  return (
    <div>
      {isOffline && (
        <Alert tone="warning" className="mt-8">
          {t('connectivity.offlineAction')}
        </Alert>
      )}

      {error !== null && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}

      {notice !== null && (
        <Alert tone="success" className="mt-6">
          {notice}
        </Alert>
      )}

      {progress !== null && (
        <p className="mt-4 text-2xs text-ink-500" role="status">
          {progress}
        </p>
      )}

      {/* Export ---------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="label-caps">{t('backup.export')}</h2>
        <p className="mt-2 max-w-prose text-2xs text-ink-400">{t('backup.exportHint')}</p>
        <p className="mt-1 max-w-prose text-2xs text-ink-400">
          {t('backup.exportNothingUploaded')}
        </p>

        <Button className="mt-4" disabled={busy || isOffline} onClick={() => void handleExport()}>
          {busy && progress !== null ? t('backup.exporting') : t('backup.export')}
        </Button>
      </section>

      {/* Import ---------------------------------------------------------- */}
      <section className="mt-10 border-t border-ink-100 pt-6">
        <h2 className="label-caps">{t('backup.import')}</h2>
        <p className="mt-2 max-w-prose text-2xs text-ink-400">{t('backup.importHint')}</p>

        <label className="mt-4 inline-flex min-h-11 cursor-pointer items-center text-sm text-ink-700 underline">
          {t('backup.chooseFile')}
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            disabled={busy || isOffline}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void handleChoose(file);
              // Cleared so choosing the same file twice re-triggers the read.
              event.target.value = '';
            }}
          />
        </label>

        {inspected !== null && (
          <div className="mt-6">
            {/* What the file says about itself. */}
            <dl className="flex flex-wrap gap-x-8 gap-y-2">
              <Fact label={t('backup.fileFrom')} value={inspected.file.exportedAt ?? '—'} />
              <Fact label={t('backup.fileProject')} value={inspected.file.projectId ?? '—'} />
              <Fact
                label={t('about.schemaVersion')}
                value={String(inspected.file.schemaVersion ?? '—')}
              />
            </dl>

            {differentProject && (
              <Alert tone="warning" className="mt-4">
                {t('backup.differentProject')}
              </Alert>
            )}

            {!inspected.validation.ok ? (
              <>
                <Alert tone="error" className="mt-4">
                  {t('backup.invalid')}
                </Alert>

                <h3 className="mt-6 text-2xs tracking-wide text-ink-400 uppercase">
                  {t('backup.problems')}
                </h3>
                <ProblemList problems={inspected.validation.problems} />
              </>
            ) : (
              <>
                <Alert tone="success" className="mt-4">
                  {t('backup.valid')}
                </Alert>

                <h3 className="mt-6 text-2xs tracking-wide text-ink-400 uppercase">
                  {t('backup.summary')}
                </h3>

                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-80 text-sm">
                    <thead>
                      <tr className="border-b border-ink-200">
                        <th scope="col" className="py-2 text-start text-2xs text-ink-400 uppercase">
                          {' '}
                        </th>
                        <th scope="col" className="py-2 text-end text-2xs text-ink-400 uppercase">
                          {t('backup.willCreate')}
                        </th>
                        <th scope="col" className="py-2 text-end text-2xs text-ink-400 uppercase">
                          {t('backup.willUpdate')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspected.plan.map((entry) => (
                        <tr key={entry.collection} className="border-b border-ink-100">
                          <td className="py-2 text-ink-900">{entry.collection}</td>
                          <td className="numeric py-2 text-end text-ink-600">{entry.create}</td>
                          <td className="numeric py-2 text-end text-ink-600">{entry.update}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {inspected.plan.some((entry) => entry.update > 0) && (
                  <Alert tone="warning" className="mt-4">
                    {t('backup.overwriteWarning')}
                  </Alert>
                )}

                <div className="mt-6 flex flex-wrap gap-3">
                  <Button disabled={busy || isOffline} onClick={() => void handleImport()}>
                    {busy ? t('backup.importing') : t('backup.confirmImport')}
                  </Button>
                  <Button variant="ghost" onClick={() => setInspected(null)}>
                    {t('backup.cancel')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {/* About ----------------------------------------------------------- */}
      <section className="mt-10 border-t border-ink-100 pt-6">
        <h2 className="label-caps">{t('about.title')}</h2>

        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Fact label={t('about.version')} value={__APP_VERSION__} />
          <Fact label={t('about.schemaVersion')} value={String(CURRENT_SCHEMA_VERSION)} />
          <Fact
            label={t('about.environment')}
            value={env === null ? '—' : t(`env.${env.appEnv}`)}
          />
          {/*
           * The project id, and nothing else about the build. It identifies
           * which database the boutique is connected to — which is exactly what
           * somebody restoring a backup needs to check — and is not a secret:
           * it is compiled into every browser bundle already.
           */}
          <Fact label={t('about.project')} value={env?.firebase.projectId ?? '—'} />
        </dl>

        <p className="mt-6 max-w-prose text-2xs text-ink-400">{t('about.fontsLicense')}</p>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-ink-400 uppercase">{label}</dt>
      <dd className="code mt-1 text-sm text-ink-900">{value}</dd>
    </div>
  );
}

/**
 * The problems, capped.
 *
 * A corrupted file can produce thousands; rendering all of them freezes the tab
 * and helps nobody. The first twenty are enough to see the pattern, and the
 * count says how many more there are.
 */
function ProblemList({ problems }: { problems: readonly BackupProblem[] }) {
  const shown = problems.slice(0, 20);

  return (
    <>
      <ul className="mt-2 space-y-1">
        {shown.map((problem, index) => (
          <li key={`${problem.where}-${String(index)}`} className="text-2xs text-ink-700">
            <span className="code text-ink-500">{problem.where}</span> — {problem.detail}
          </li>
        ))}
      </ul>

      {problems.length > shown.length && (
        <p className="mt-2 text-2xs text-ink-400">
          + {problems.length - shown.length}
        </p>
      )}
    </>
  );
}
