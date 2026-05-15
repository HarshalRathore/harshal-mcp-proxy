/**
 * connection-state.ts — Connection state machine types and helpers.
 */
export function isConnected(state) {
    return state === 'connected';
}
export function canConnect(state) {
    return state === 'disconnected' || state === 'failed';
}
export function createServerRecord() {
    return {
        state: 'disconnected',
        lastUsedAt: 0,
        connectedAt: 0,
        requestCount: 0,
    };
}
//# sourceMappingURL=connection-state.js.map