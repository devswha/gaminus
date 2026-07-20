export interface UpdateStatusResponse {
    operationId?: unknown;
    updateState?: unknown;
    failure?: unknown;
}

export interface UpdatePollingInput {
    status?: UpdateStatusResponse;
    operationId: string;
    elapsedMs: number;
    timeoutMs: number;
    networkError?: unknown;
}

export type UpdatePollingDecision =
    | { action: 'continue' }
    | { action: 'success' }
    | { action: 'failure'; reason: string }
    | { action: 'timeout' };

export function decideUpdatePolling({
    status,
    operationId,
    elapsedMs,
    timeoutMs,
}: UpdatePollingInput): UpdatePollingDecision {
    if (elapsedMs >= timeoutMs) {
        return { action: 'timeout' };
    }

    if (!status || status.operationId !== operationId) {
        return { action: 'continue' };
    }

    if (status.updateState === 'current') {
        return { action: 'success' };
    }

    if (status.updateState === 'failed' || status.updateState === 'rolled_back') {
        return {
            action: 'failure',
            reason: typeof status.failure === 'string' && status.failure.length > 0
                ? status.failure
                : `Update ${status.updateState}.`,
        };
    }

    return { action: 'continue' };
}
