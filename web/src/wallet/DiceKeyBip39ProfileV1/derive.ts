import { SeededCryptoModulePromise } from "@dicekeys/seeded-crypto-js";

import {
  DiceKeyFaces,
  diceKeyFacesToSeedString,
} from "../../dicekeys/DiceKey";
import { toBip39 } from "../../formats/bip39/bip39";
import { DK_BIP39_24_V1, WalletMnemonicResult } from "./profile";
import { validateWalletDiceKeyFaces } from "./validate";

interface WalletMnemonicResultWithEntropy extends WalletMnemonicResult {
  readonly entropy: Uint8ClampedArray;
}

const deriveOwnedEntropy = async (
  canonicalSeed: string,
): Promise<Uint8ClampedArray> => {
  const seededCryptoModule = await SeededCryptoModulePromise;
  let secret: ReturnType<
    typeof seededCryptoModule.Secret.deriveFromSeed
  > | undefined;
  let ownedEntropy: Uint8ClampedArray | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;

  const recordFirstError = (error: unknown): void => {
    if (hasPrimaryError) return;
    hasPrimaryError = true;
    if (typeof error === "number") {
      try {
        primaryError = new Error(seededCryptoModule.getExceptionMessage(error));
      } catch {
        primaryError = new Error("Seeded crypto operation failed");
      }
    } else {
      primaryError = error;
    }
  };

  try {
    secret = seededCryptoModule.Secret.deriveFromSeed(
      canonicalSeed,
      DK_BIP39_24_V1.recipe,
    );
    let extractedSecretBytes: Uint8Array | undefined;
    try {
      extractedSecretBytes = secret.secretBytes;
      ownedEntropy = new Uint8ClampedArray(extractedSecretBytes);
    } catch (error) {
      recordFirstError(error);
    } finally {
      if (extractedSecretBytes != null) {
        try {
          extractedSecretBytes.fill(0);
        } catch (error) {
          recordFirstError(error);
        }
      }
    }
  } catch (error) {
    recordFirstError(error);
  } finally {
    if (secret != null) {
      try {
        secret.delete();
      } catch (error) {
        recordFirstError(error);
      }
    }
  }

  if (hasPrimaryError) {
    // A copy must not survive when source/native cleanup fails after copying.
    // Never let this final best-effort wipe replace the first recorded error.
    try {
      ownedEntropy?.fill(0);
    } catch {
      // The first operation or cleanup error remains authoritative.
    }
    throw primaryError;
  }
  if (ownedEntropy == null) {
    throw new Error("Seeded crypto operation did not return secret bytes");
  }
  return ownedEntropy;
};

/**
 * Internal deterministic core. Tests import this file directly to compare the
 * owned entropy with frozen vectors. It is deliberately absent from index.ts.
 */
export const deriveWalletMnemonicV1WithEntropyForTests = async (
  candidateFaces: DiceKeyFaces,
): Promise<WalletMnemonicResultWithEntropy> => {
  // Both validation and canonicalization happen before the first await.
  const faces = validateWalletDiceKeyFaces(candidateFaces);
  const canonicalSeed = diceKeyFacesToSeedString(faces);
  const entropy = await deriveOwnedEntropy(canonicalSeed);

  if (entropy.length !== 32) {
    entropy.fill(0);
    throw new Error("Wallet profile derivation did not produce 32 bytes");
  }

  try {
    const mnemonic = await toBip39(entropy);
    const words = Object.freeze(mnemonic.split(" ")) as readonly string[];
    if (
      words.length !== DK_BIP39_24_V1.wordCount ||
      words.some((word) => word.length === 0) ||
      words.join(" ") !== mnemonic
    ) {
      throw new Error("Wallet profile derivation did not produce 24 words");
    }

    return Object.freeze({
      profileId: DK_BIP39_24_V1.id,
      words,
      mnemonic,
      entropy,
    });
  } catch (error) {
    entropy.fill(0);
    throw error;
  }
};

export async function deriveWalletMnemonicV1(
  candidateFaces: DiceKeyFaces,
): Promise<WalletMnemonicResult> {
  if (arguments.length !== 1) {
    throw new TypeError("Wallet profile derivation accepts exactly one argument");
  }

  const internalResult = await deriveWalletMnemonicV1WithEntropyForTests(
    candidateFaces,
  );
  try {
    return Object.freeze({
      profileId: internalResult.profileId,
      words: internalResult.words,
      mnemonic: internalResult.mnemonic,
    });
  } finally {
    // Typed arrays cannot be frozen. Clear the only owned entropy copy before
    // returning the public, mnemonic-only result.
    try {
      internalResult.entropy.fill(0);
    } catch {
      // Best effort only; never replace an otherwise valid derivation result.
    }
  }
}
