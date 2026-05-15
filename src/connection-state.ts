/**
 * connection-state.ts — Connection state machine types and helpers.
 */

import type { ConnectionState, ServerConnectionRecord } from "./types.js";

export function isConnected(state: ConnectionState): boolean {
  return state === 'connected';
}

export function canConnect(state: ConnectionState): boolean {
  return state === 'disconnected' || state === 'failed';
}

export function createServerRecord(): ServerConnectionRecord {
  return {
    state: 'disconnected',
    lastUsedAt: 0,
    connectedAt: 0,
    requestCount: 0,
  };
}
