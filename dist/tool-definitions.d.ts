/**
 * tool-definitions.ts — Single source of truth for the gateway's MCP tools.
 *
 * Each tool is defined once as data: name, title, description, zod input
 * shape, and a runner. Transports build McpServers from this list
 * (handlers.ts for stdio, http-server.ts per client session), so both modes
 * expose identical tools, schemas, and behavior.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GatewayTools } from "./tools.js";
/** Serialize a payload as pretty JSON text content. */
export declare function textResult(payload: unknown): CallToolResult;
/** Format a thrown error as an MCP tool error. */
export declare function errorResult(error: unknown): CallToolResult;
export interface ToolDefinition {
    name: string;
    title: string;
    description: string;
    /** Validated args schema — drives both input validation and JSON Schema */
    schema: z.AnyZodObject;
    /** Runs the tool against the shared services. Throws on business errors. */
    run(tools: GatewayTools, args: Record<string, unknown>): unknown | Promise<unknown>;
}
/** All gateway tools, in the order they appear in tools/list. */
export declare const TOOL_DEFINITIONS: ToolDefinition[];
