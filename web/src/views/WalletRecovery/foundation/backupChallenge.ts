import {
  RECOVERY_WORD_POSITIONS,
  RecoveryTransitionError,
} from "./types";
import type {
  RecoveryWordPosition,
  SecureGetRandomValues,
} from "./types";

const UINT32_RANGE = 0x1_0000_0000;

const defaultGetRandomValues: SecureGetRandomValues = <T extends Uint32Array>(
  values: T,
): T => {
  const webCrypto = globalThis.crypto;
  if (webCrypto == null || typeof webCrypto.getRandomValues !== "function") {
    throw new RecoveryTransitionError("SECURE_RANDOM_UNAVAILABLE");
  }
  return webCrypto.getRandomValues(values);
};

const randomIntegerBelow = (
  upperBound: number,
  getRandomValues: SecureGetRandomValues,
): number => {
  const rejectionLimit = UINT32_RANGE - (UINT32_RANGE % upperBound);
  const sample = new Uint32Array(1);
  do {
    try {
      getRandomValues(sample);
    } catch {
      throw new RecoveryTransitionError("SECURE_RANDOM_UNAVAILABLE");
    }
  } while (sample[0]! >= rejectionLimit);
  return sample[0]! % upperBound;
};

/**
 * Select six positions without replacement.  Rejection sampling avoids the
 * modulo bias that would otherwise favor some positions.
 */
export const selectSixUniqueRecoveryWordPositions = (
  getRandomValues: SecureGetRandomValues = defaultGetRandomValues,
): readonly RecoveryWordPosition[] => {
  const available = [...RECOVERY_WORD_POSITIONS];
  const selected: RecoveryWordPosition[] = [];
  for (let index = 0; index < 6; index += 1) {
    const selectedOffset = randomIntegerBelow(
      available.length,
      getRandomValues,
    );
    selected.push(available.splice(selectedOffset, 1)[0]!);
  }
  selected.sort((left, right) => left - right);
  return Object.freeze(selected);
};
