declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: import('./types.js').ToolRuntimeService
    systemPrompt: import('./types.js').SystemPromptService
    inject(deps: unknown, callback: (ctx: Context) => void): void
    get?(name: string): unknown
  }
}
