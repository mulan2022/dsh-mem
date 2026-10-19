import '@deepseek-ai/dsh-llm/message';

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    'plugin:dsh-mem': {
      readonly kind: 'plugin:dsh-mem';
      readonly form?: 'snapshot' | 'recall' | 'notice';
      readonly sections?: readonly { name: string; text: string }[];
      readonly summary?: string;
    };
  }
}
