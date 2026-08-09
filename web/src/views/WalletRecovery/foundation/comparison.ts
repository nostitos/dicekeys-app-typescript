import type {
  DiceKeyFaces,
  OrientedFace,
} from "../../../dicekeys/DiceKey";
import { rotateDiceKey } from "../../../dicekeys/DiceKey/Rotation";
import type {
  ComparedFaceField,
  DiceKeyRotationComparisonResult,
  FaceDifference,
  GridCoordinate,
  PhysicalFacePosition,
  QuarterTurnsClockwise,
  RecoveryDiceKeyFace,
  RotationComparison,
} from "./types";

const ROTATIONS = Object.freeze([0, 1, 2, 3] as const);

const freezeFace = (face: OrientedFace): RecoveryDiceKeyFace => Object.freeze({
  letter: face.letter,
  digit: face.digit,
  orientationAsLowercaseLetterTrbl:
    face.orientationAsLowercaseLetterTrbl,
});

const freezeDifference = (
  index: number,
  fields: ComparedFaceField[],
  firstScanFace: OrientedFace,
  secondScanFace: OrientedFace,
): FaceDifference => Object.freeze({
  position: (index + 1) as PhysicalFacePosition,
  row: (Math.floor(index / 5) + 1) as GridCoordinate,
  column: ((index % 5) + 1) as GridCoordinate,
  fields: Object.freeze(fields),
  firstScanFace: freezeFace(firstScanFace),
  secondScanFace: freezeFace(secondScanFace),
});

const compareAtRotation = (
  first: DiceKeyFaces,
  second: DiceKeyFaces,
  rotation: QuarterTurnsClockwise,
): RotationComparison => {
  const rotatedSecond = rotateDiceKey(second, rotation);
  const differences: FaceDifference[] = [];

  for (let index = 0; index < 25; index += 1) {
    const expected = first[index]!;
    const actual = rotatedSecond[index]!;
    const fields: ComparedFaceField[] = [];
    if (expected.letter !== actual.letter) fields.push("letter");
    if (expected.digit !== actual.digit) fields.push("digit");
    if (
      expected.orientationAsLowercaseLetterTrbl !==
      actual.orientationAsLowercaseLetterTrbl
    ) {
      fields.push("orientation");
    }
    if (fields.length > 0) {
      differences.push(freezeDifference(index, fields, expected, actual));
    }
  }

  return Object.freeze({
    rotation,
    differences: Object.freeze(differences),
  });
};

/** Compare every physical rotation and never infer an alignment from a tie. */
export const compareDiceKeysModuloRotation = (
  first: DiceKeyFaces,
  second: DiceKeyFaces,
): DiceKeyRotationComparisonResult => {
  const comparisons = Object.freeze(
    ROTATIONS.map((rotation) => compareAtRotation(first, second, rotation)),
  );
  const exactMatches = comparisons.filter(
    ({ differences }) => differences.length === 0,
  );

  if (exactMatches.length === 1) {
    return Object.freeze({
      kind: "match",
      rotation: exactMatches[0]!.rotation,
    });
  }

  const minimumDifferenceCount = comparisons.reduce(
    (minimum, comparison) => Math.min(minimum, comparison.differences.length),
    Number.POSITIVE_INFINITY,
  );
  const tiedComparisons = Object.freeze(
    comparisons.filter(
      ({ differences }) => differences.length === minimumDifferenceCount,
    ),
  );

  if (exactMatches.length === 0 && tiedComparisons.length === 1) {
    return Object.freeze({
      kind: "mismatch",
      bestComparison: tiedComparisons[0]!,
    });
  }

  return Object.freeze({
    kind: "alignment-ambiguous",
    tiedComparisons,
  });
};
