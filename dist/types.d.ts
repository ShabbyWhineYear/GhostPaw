/**
 * DeepSeek Harness & Cordis Service Type Declarations for GhostPaw
 */
export interface TextContentBlock {
    readonly type: 'text';
    readonly text: string;
}
export interface ImageContentBlock {
    readonly type: 'image';
    readonly attachment: {
        readonly attachmentId: string;
        readonly mediaType: string;
        readonly bytes: number;
        readonly width: number;
        readonly height: number;
        readonly name?: string;
        readonly originalDimensions?: {
            readonly width: number;
            readonly height: number;
        };
    };
}
export type ToolContentBlock = TextContentBlock | ImageContentBlock;
export interface JsonSchemaProperty {
    readonly type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
    readonly description?: string;
    readonly enum?: readonly (string | number | boolean)[];
    readonly const?: string | number | boolean | null;
    readonly items?: JsonSchemaProperty;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
}
export interface ObjectJsonSchema {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
}
export interface ToolRunContext {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
    readonly signal: AbortSignal;
    readonly agent?: {
        readonly id?: string;
        readonly ctx?: import('@deepseek-ai/cordis').Context;
    };
}
export interface ToolOutputDefinition<TArgs = unknown, TValue = unknown> {
    readonly schema: JsonSchemaProperty | ObjectJsonSchema;
    render(args: TArgs, value: TValue): readonly ToolContentBlock[];
}
export interface ToolDefinition<TArgs = unknown, TValue = unknown> {
    readonly name: string;
    readonly description: string;
    readonly parameters: ObjectJsonSchema | Record<string, unknown>;
    readonly output: ToolOutputDefinition<TArgs, TValue>;
    execute(args: TArgs, exec: ToolRunContext): Promise<TValue>;
    isConcurrencySafe?(args: TArgs): boolean;
    timeoutMs?: number;
}
export interface ToolRuntimeService {
    register<TArgs = unknown, TValue = unknown>(definition: ToolDefinition<TArgs, TValue>): () => void;
    guard?(guard: (exec: Readonly<ToolRunContext>) => string | undefined): () => void;
}
export interface PromptSection {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: {
        scope?: unknown;
        signal?: AbortSignal;
        agent?: unknown;
    }) => string);
    readonly complete?: boolean;
    readonly interpolate?: boolean;
}
export interface PromptContext {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: {
        scope?: unknown;
        signal?: AbortSignal;
    }) => string);
    readonly interpolate?: boolean;
}
export interface SystemPromptService {
    section(section: PromptSection): () => void;
    context?(ctx: PromptContext): () => void;
}
