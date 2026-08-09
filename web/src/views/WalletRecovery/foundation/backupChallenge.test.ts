import { selectSixUniqueRecoveryWordPositions } from "./backupChallenge";
import type { SecureGetRandomValues } from "./types";

const rngFrom = (samples: readonly number[]): {
  readonly getRandomValues: SecureGetRandomValues;
  readonly callCount: () => number;
} => {
  let callIndex = 0;
  return {
    getRandomValues: <T extends Uint32Array>(target: T): T => {
      const sample = samples[callIndex];
      if (sample == null) throw new Error("test RNG exhausted");
      callIndex += 1;
      target[0] = sample;
      return target;
    },
    callCount: () => callIndex,
  };
};

describe("selectSixUniqueRecoveryWordPositions", () => {
  test("returns six unique, sorted positions in the inclusive 1..24 range", () => {
    const rng = rngFrom([23, 0, 7, 15, 3, 11]);
    const positions = selectSixUniqueRecoveryWordPositions(rng.getRandomValues);

    expect(positions).toHaveLength(6);
    expect(new Set(positions).size).toBe(6);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(positions.every((position) => position >= 1 && position <= 24))
      .toBe(true);
    expect(Object.isFrozen(positions)).toBe(true);
  });

  test("samples without replacement even when the RNG repeatedly chooses zero", () => {
    const rng = rngFrom([0, 0, 0, 0, 0, 0]);
    expect(selectSixUniqueRecoveryWordPositions(rng.getRandomValues)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  test("rejects out-of-range uint32 samples instead of introducing modulo bias", () => {
    // For an upper bound of 24, values 2^32-16 through 2^32-1 must be rejected.
    const rng = rngFrom([0xffff_ffff, 5, 0, 0, 0, 0, 0]);
    const positions = selectSixUniqueRecoveryWordPositions(rng.getRandomValues);

    expect(positions).toHaveLength(6);
    expect(rng.callCount()).toBe(7);
  });

  test("maps any injected RNG failure to a fixed non-sensitive code", () => {
    const failingRng: SecureGetRandomValues = <T extends Uint32Array>(
      _target: T,
    ): T => {
      throw new Error("sensitive provider details");
    };

    expect(() => selectSixUniqueRecoveryWordPositions(failingRng)).toThrow(
      expect.objectContaining({ code: "SECURE_RANDOM_UNAVAILABLE" }),
    );
    try {
      selectSixUniqueRecoveryWordPositions(failingRng);
    } catch (error) {
      expect((error as Error).message).not.toContain("sensitive provider details");
    }
  });
});
