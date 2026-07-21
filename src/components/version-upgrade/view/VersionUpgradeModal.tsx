import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";

import { authenticatedFetch } from "../../../utils/api";
import { ReleaseInfo } from "../../../types/sharedTypes";
import { copyTextToClipboard } from "../../../utils/clipboard";
import type { InstallMode } from "../../../hooks/useVersionCheck";
import { decideUpdatePolling, type UpdatePollingDecision } from "../utils/updatePolling";

interface VersionUpgradeModalProps {
    isOpen: boolean;
    onClose: () => void;
    releaseInfo: ReleaseInfo | null;
    currentVersion: string;
    latestVersion: string | null;
    installMode: InstallMode;
}

export function VersionUpgradeModal({
    isOpen,
    onClose,
    releaseInfo,
    currentVersion,
    latestVersion,
    installMode
}: VersionUpgradeModalProps) {
    const { t } = useTranslation('common');
    const isManagedInstall = installMode === 'managed';
    const upgradeCommand = isManagedInstall
        ? 'gaminus.sh update'
        : 'git checkout main && git pull && npm install';
    const updatePollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const updatePollSession = useRef(0);
    const [isUpdating, setIsUpdating] = useState(false);
    const [updateOutput, setUpdateOutput] = useState('');
    const [updateError, setUpdateError] = useState('');

    useEffect(() => {
        if (!isOpen) {
            updatePollSession.current += 1;
            if (updatePollTimer.current) {
                clearTimeout(updatePollTimer.current);
                updatePollTimer.current = null;
            }
        }

        return () => {
            updatePollSession.current += 1;
            if (updatePollTimer.current) {
                clearTimeout(updatePollTimer.current);
                updatePollTimer.current = null;
            }
        };
    }, [isOpen]);

    const handleUpdateNow = useCallback(async () => {
        const pollIntervalMs = 3_000;
        const pollTimeoutMs = 5 * 60 * 1_000;
        const startedAt = Date.now();
        let operationId: string | null = null;
        const pollSession = updatePollSession.current + 1;
        updatePollSession.current = pollSession;
        let polling = true;

        const stopPolling = () => {
            polling = false;
            if (updatePollSession.current === pollSession && updatePollTimer.current) {
                clearTimeout(updatePollTimer.current);
                updatePollTimer.current = null;
            }
        };
        const failUpdate = (message: string) => {
            if (!polling || updatePollSession.current !== pollSession) return;
            stopPolling();
            setIsUpdating(false);
            setUpdateError(message);
            setUpdateOutput(prev => `${prev}\nUpdate failed: ${message}\n`);
        };
        const handlePollingDecision = (decision: UpdatePollingDecision) => {
            if (decision.action === 'continue') return false;

            if (decision.action === 'timeout') {
                failUpdate('Update status timed out. Check the deployment status and update manually if needed.');
                return true;
            }

            if (decision.action === 'failure') {
                failUpdate(decision.reason);
                return true;
            }

            stopPolling();
            if (updatePollSession.current !== pollSession) return true;
            setIsUpdating(false);
            setUpdateOutput(prev => `${prev}\nUpdate completed successfully.\nPlease restart the server to apply changes.\n`);
            return true;
        };
        const schedulePolling = () => {
            if (updatePollSession.current === pollSession) {
                updatePollTimer.current = setTimeout(pollStatus, pollIntervalMs);
            }
        };
        const pollStatus = async () => {
            if (!polling || updatePollSession.current !== pollSession || !operationId) return;

            const elapsedMs = Date.now() - startedAt;
            if (handlePollingDecision(decideUpdatePolling({
                operationId,
                elapsedMs,
                timeoutMs: pollTimeoutMs,
            }))) {
                return;
            }

            try {
                const response = await authenticatedFetch('/api/system/update/status');
                const status = response.ok
                    ? await response.json() as {
                        operationId?: unknown;
                        updateState?: unknown;
                        failure?: unknown;
                    }
                    : undefined;
                const decision = decideUpdatePolling({
                    operationId,
                    elapsedMs: Date.now() - startedAt,
                    timeoutMs: pollTimeoutMs,
                    status,
                    networkError: response.ok ? undefined : new Error(`Status request failed with ${response.status}.`),
                });

                if (!handlePollingDecision(decision)) {
                    schedulePolling();
                }
            } catch (error) {
                const decision = decideUpdatePolling({
                    operationId,
                    elapsedMs: Date.now() - startedAt,
                    timeoutMs: pollTimeoutMs,
                    networkError: error,
                });

                if (!handlePollingDecision(decision)) {
                    schedulePolling();
                }
            }
        };

        setIsUpdating(true);
        setUpdateOutput('Update started. Waiting for deployment status...\n');
        setUpdateError('');

        try {
            const response = await authenticatedFetch('/api/system/update', {
                method: 'POST',
            });
            const data = await response.json() as { error?: unknown; operationId?: unknown };

            if (response.status === 202) {
                if (typeof data.operationId !== 'string' || data.operationId.length === 0) {
                    failUpdate('Update request did not return an operation ID.');
                    return;
                }

                operationId = data.operationId;
                schedulePolling();
                return;
            }

            const serverError = typeof data.error === 'string' ? data.error : 'Update failed';
            const manualGuidance = [409, 423, 502, 503].includes(response.status)
                ? ' Update manually from your installation directory.'
                : '';
            failUpdate(`${serverError}${manualGuidance}`);
        } catch (error) {
            failUpdate(error instanceof Error ? error.message : 'Update failed');
        }
    }, []);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <button
                className="fixed inset-0 bg-black/50 backdrop-blur-sm"
                onClick={onClose}
                aria-label={t('versionUpdate.ariaLabels.closeModal')}
            />

            {/* Modal */}
            <div className="relative mx-4 max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-800">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                            <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('versionUpdate.title')}</h2>
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {releaseInfo?.title || t('versionUpdate.newVersionReady')}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                    >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Version Info */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between rounded-lg bg-gray-50 p-3 dark:bg-gray-700/50">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('versionUpdate.currentVersion')}</span>
                        <span className="font-mono text-sm text-gray-900 dark:text-white">{currentVersion}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-700 dark:bg-blue-900/20">
                        <span className="text-sm font-medium text-blue-700 dark:text-blue-300">{t('versionUpdate.latestVersion')}</span>
                        <span className="font-mono text-sm text-blue-900 dark:text-blue-100">{latestVersion}</span>
                    </div>
                </div>

                {/* Changelog */}
                {releaseInfo?.body && (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-medium text-gray-900 dark:text-white">{t('versionUpdate.whatsNew')}</h3>
                            {releaseInfo?.htmlUrl && (
                                <a
                                    href={releaseInfo.htmlUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                                >
                                    {t('versionUpdate.viewFullRelease')}
                                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                </a>
                            )}
                        </div>
                        <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700/50">
                            <div className="prose prose-sm max-w-none text-sm text-gray-700 dark:prose-invert dark:text-gray-300">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={changelogComponents}>
                                    {cleanChangelog(releaseInfo.body)}
                                </ReactMarkdown>
                            </div>
                        </div>
                    </div>
                )}

                {/* Update Output */}
                {(updateOutput || updateError) && (
                    <div className="space-y-2">
                        <h3 className="text-sm font-medium text-gray-900 dark:text-white">{t('versionUpdate.updateProgress')}</h3>
                        <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 p-4 dark:bg-gray-950">
                            <pre className="whitespace-pre-wrap font-mono text-xs text-green-400">{updateOutput}</pre>
                        </div>
                        {updateError && (
                            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
                                {updateError}
                            </div>
                        )}
                    </div>
                )}

                {/* Upgrade Instructions */}
                {(!isManagedInstall || updateError || (!isUpdating && !updateOutput)) && (
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium text-gray-900 dark:text-white">{t('versionUpdate.manualUpgrade')}</h3>
                        <div className="rounded-lg border bg-gray-100 p-3 dark:bg-gray-800">
                            <code className="font-mono text-sm text-gray-800 dark:text-gray-200">
                                {upgradeCommand}
                            </code>
                        </div>
                        <p className="text-xs text-gray-600 dark:text-gray-400">
                            {t('versionUpdate.manualUpgradeHint')}
                        </p>
                    </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-2">
                    <button
                        onClick={onClose}
                        className="flex-1 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                    >
                        {updateOutput ? t('versionUpdate.buttons.close') : t('versionUpdate.buttons.later')}
                    </button>
                    {!isUpdating && (!updateOutput || updateError) && (
                        <button
                            onClick={() => copyTextToClipboard(upgradeCommand)}
                            className="flex-1 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                        >
                            {t('versionUpdate.buttons.copyCommand')}
                        </button>
                    )}
                    {isManagedInstall && !updateOutput && (
                        <button
                            onClick={handleUpdateNow}
                            disabled={isUpdating}
                            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
                        >
                            {isUpdating ? (
                                <>
                                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                    {t('versionUpdate.buttons.updating')}
                                </>
                            ) : (
                                t('versionUpdate.buttons.updateNow')
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

const changelogComponents = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
            {children}
        </a>
    ),
};

// Clean up changelog by removing GitHub-specific metadata
const cleanChangelog = (body: string) => {
    if (!body) return '';

    return body
        // Remove full commit hashes (40 character hex strings)
        .replace(/\b[0-9a-f]{40}\b/gi, '')
        // Remove short commit hashes (7-10 character hex strings at start of line or after dash/space)
        .replace(/(?:^|\s|-)([0-9a-f]{7,10})\b/gi, '')
        // Remove "Full Changelog" links
        .replace(/\*\*Full Changelog\*\*:.*$/gim, '')
        // Remove compare links (e.g., https://github.com/.../compare/v1.0.0...v1.0.1)
        .replace(/https?:\/\/github\.com\/[^\/]+\/[^\/]+\/compare\/[^\s)]+/gi, '')
        // Clean up multiple consecutive empty lines
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        // Trim whitespace
        .trim();
};
