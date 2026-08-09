import type { WalletMnemonicResult } from "../DiceKeyBip39ProfileV1/profile";
import { RECOVERY_PROFILE_CHECK_CODE_V1 } from "./profile";
import {
  readCanonicalMnemonicFromWalletResult,
  sha256Digest,
  validateCanonicalWalletMnemonic,
} from "./validate";

interface RecoveryProfileCheckCodeV1InternalResult {
  readonly digest: Uint8Array;
  readonly checkCode: string;
}

const textEncoder = new TextEncoder();
const fixedPreimagePrefix = textEncoder.encode(
  `${RECOVERY_PROFILE_CHECK_CODE_V1.domain}\0${RECOVERY_PROFILE_CHECK_CODE_V1.profileId}\0`,
);

const wipeBestEffort = (bytes: Uint8Array | undefined): void => {
  try {
    bytes?.fill(0);
  } catch {
    // JavaScript cannot guarantee erasure; cleanup must not replace the result.
  }
};

const formatCheckCode = (digest: Uint8Array): string => {
  const ungrouped = Array.from(
    digest.subarray(0, RECOVERY_PROFILE_CHECK_CODE_V1.codeByteLength),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
  return `${ungrouped.slice(0, 4)}-${ungrouped.slice(4, 8)}-${ungrouped.slice(8, 12)}`;
};

/** Internal full-digest core for conformance tests; absent from index.ts. */
export async function deriveRecoveryProfileCheckCodeV1FromCanonicalMnemonicForTests(
  candidateMnemonic: string,
): Promise<RecoveryProfileCheckCodeV1InternalResult> {
  if (arguments.length !== 1) {
    throw new TypeError("Check-code derivation accepts exactly one mnemonic");
  }
  const mnemonic = await validateCanonicalWalletMnemonic(candidateMnemonic);
  const mnemonicBytes = textEncoder.encode(mnemonic);
  const preimage = new Uint8Array(
    fixedPreimagePrefix.length + mnemonicBytes.length,
  );
  preimage.set(fixedPreimagePrefix);
  preimage.set(mnemonicBytes, fixedPreimagePrefix.length);

  let digest: Uint8Array | undefined;
  try {
    digest = await sha256Digest(preimage);
    const result = Object.freeze({
      digest,
      checkCode: formatCheckCode(digest),
    });
    digest = undefined;
    return result;
  } finally {
    wipeBestEffort(mnemonicBytes);
    wipeBestEffort(preimage);
    wipeBestEffort(digest);
  }
}

export async function deriveRecoveryProfileCheckCodeV1(
  walletResult: WalletMnemonicResult,
): Promise<string> {
  if (arguments.length !== 1) {
    throw new TypeError("Check-code derivation accepts exactly one wallet result");
  }
  const mnemonic = readCanonicalMnemonicFromWalletResult(walletResult);
  const internalResult =
    await deriveRecoveryProfileCheckCodeV1FromCanonicalMnemonicForTests(
      mnemonic,
    );
  try {
    return internalResult.checkCode;
  } finally {
    wipeBestEffort(internalResult.digest);
  }
}
