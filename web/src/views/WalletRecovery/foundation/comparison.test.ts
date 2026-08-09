import type { DiceKeyFaces, OrientedFace } from "../../../dicekeys/DiceKey";
import { DiceKeyWithoutKeyId } from "../../../dicekeys/DiceKey";
import { rotateDiceKey } from "../../../dicekeys/DiceKey/Rotation";
import { compareDiceKeysModuloRotation } from "./comparison";

const baseFaces = DiceKeyWithoutKeyId.testExample.faces;

const replaceFace = (
  faces: DiceKeyFaces,
  index: number,
  replacement: Partial<OrientedFace>,
): DiceKeyFaces => faces.map((face, faceIndex) => Object.freeze(
  faceIndex === index ? { ...face, ...replacement } : { ...face },
)) as unknown as DiceKeyFaces;

const uniformFaces = (face: OrientedFace): DiceKeyFaces => Object.freeze(
  Array.from({ length: 25 }, () => Object.freeze({ ...face })),
) as unknown as DiceKeyFaces;

describe("compareDiceKeysModuloRotation", () => {
  test.each([0, 1, 2, 3] as const)(
    "enumerates all rotations and matches a key physically rotated %i quarter turns",
    (physicalRotation) => {
      const result = compareDiceKeysModuloRotation(
        baseFaces,
        rotateDiceKey(baseFaces, physicalRotation),
      );

      expect(result.kind).toBe("match");
      if (result.kind !== "match") throw new Error("expected a match");
      expect(result.rotation).toBe((4 - physicalRotation) % 4);
      expect(Object.keys(result).sort()).toEqual(["kind", "rotation"]);
    },
  );

  test("reports an exact one-based position, row, column, and changed field", () => {
    const changed = replaceFace(baseFaces, 7, {
      digit: baseFaces[7]!.digit === "1" ? "2" : "1",
    });
    const result = compareDiceKeysModuloRotation(
      baseFaces,
      rotateDiceKey(changed, 1),
    );

    expect(result.kind).toBe("mismatch");
    if (result.kind !== "mismatch") throw new Error("expected a mismatch");
    expect(result.bestComparison.rotation).toBe(3);
    expect(result.bestComparison.differences).toEqual([{
      position: 8,
      row: 2,
      column: 3,
      fields: ["digit"],
      firstScanFace: baseFaces[7],
      secondScanFace: changed[7],
    }]);
  });

  test("reports letter, digit, and orientation differences in fixed order", () => {
    const changed = replaceFace(baseFaces, 0, {
      letter: "Y",
      digit: baseFaces[0]!.digit === "1" ? "2" : "1",
      orientationAsLowercaseLetterTrbl:
        baseFaces[0]!.orientationAsLowercaseLetterTrbl === "r" ? "l" : "r",
    });
    const result = compareDiceKeysModuloRotation(baseFaces, changed);

    expect(result.kind).toBe("mismatch");
    if (result.kind !== "mismatch") throw new Error("expected a mismatch");
    expect(result.bestComparison.differences[0]).toEqual({
      position: 1,
      row: 1,
      column: 1,
      fields: ["letter", "digit", "orientation"],
      firstScanFace: baseFaces[0],
      secondScanFace: changed[0],
    });
  });

  test("returns every tied minimum comparison and never guesses an alignment", () => {
    const first = uniformFaces({
      letter: "A",
      digit: "1",
      orientationAsLowercaseLetterTrbl: "t",
    });
    const second = uniformFaces({
      letter: "B",
      digit: "2",
      orientationAsLowercaseLetterTrbl: "t",
    });
    const result = compareDiceKeysModuloRotation(first, second);

    expect(result.kind).toBe("alignment-ambiguous");
    if (result.kind !== "alignment-ambiguous") {
      throw new Error("expected ambiguous alignment");
    }
    expect(result.tiedComparisons).toHaveLength(4);
    expect(result.tiedComparisons.map(({ rotation }) => rotation)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  test("deep-freezes comparison output", () => {
    const changed = replaceFace(baseFaces, 0, { digit: "6" });
    const result = compareDiceKeysModuloRotation(baseFaces, changed);

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.kind).toBe("mismatch");
    if (result.kind !== "mismatch") throw new Error("expected mismatch");
    expect(Object.isFrozen(result.bestComparison)).toBe(true);
    expect(Object.isFrozen(result.bestComparison.differences)).toBe(true);
    const difference = result.bestComparison.differences[0]!;
    expect(Object.isFrozen(difference)).toBe(true);
    expect(Object.isFrozen(difference.fields)).toBe(true);
    expect(Object.isFrozen(difference.firstScanFace)).toBe(true);
    expect(Object.isFrozen(difference.secondScanFace)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["bestComparison", "kind"]);
  });
});
