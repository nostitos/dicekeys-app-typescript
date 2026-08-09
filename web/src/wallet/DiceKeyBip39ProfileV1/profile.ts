export const DK_BIP39_24_V1 = Object.freeze({
  id: "DK-BIP39-24-v1",
  recipe: '{"purpose":"wallet"}',
  wordCount: 24,
} as const);

export interface WalletMnemonicResult {
  readonly profileId: typeof DK_BIP39_24_V1.id;
  readonly words: readonly string[];
  readonly mnemonic: string;
}
