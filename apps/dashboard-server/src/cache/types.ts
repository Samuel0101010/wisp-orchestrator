export interface BundleKeyInput {
  systemPrompt: string;
  allowedTools: string[];
  model: string;
}

export interface UpsertResult {
  bundleKey: string;
  cwd: string;
  isNew: boolean;
}
