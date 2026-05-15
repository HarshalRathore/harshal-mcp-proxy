/**
 * connection-state.ts — Connection state machine types and helpers.
 */
import type { ConnectionState, ServerConnectionRecord } from "./types.js";
export declare function isConnected(state: ConnectionState): boolean;
export declare function canConnect(state: ConnectionState): boolean;
export declare function createServerRecord(): ServerConnectionRecord;
