import rawTestVectors from "../../../../spec/test-vectors.json";

export interface WalletProfileTestVector {
  readonly id: string;
  readonly profile: string;
  readonly diceKeyHumanReadableForm: string;
  readonly allFourRotations: readonly string[];
  readonly canonicalSeedString: string;
  readonly recipeUtf8Hex: string;
  readonly derivedEntropyHex: string;
  readonly mnemonic: string;
}

export interface WalletProfileInvalidTestCase {
  readonly id: string;
  readonly diceKeyHumanReadableForm: string;
  readonly expectedErrorCode: string;
}

export interface WalletProfileAcquisitionPolicyCase {
  readonly id: string;
  readonly candidateHumanReadableForms: readonly string[];
  readonly expectedAcquisitionState: string;
  readonly humanReadableFormProduced: boolean;
  readonly profileDerivationInvoked: boolean;
}

interface CanonicalTestVectorFile {
  readonly profile: string;
  readonly validVectorIdsInOrder: readonly string[];
  readonly vectors: readonly Omit<WalletProfileTestVector, "id">[];
  readonly invalidCases: readonly WalletProfileInvalidTestCase[];
  readonly acquisitionPolicyCases: readonly WalletProfileAcquisitionPolicyCase[];
  readonly provenance: {
    readonly bip39EnglishWordList: {
      readonly entryCount: number;
      readonly lfTerminatedAsciiByteLength: number;
      readonly lfTerminatedAsciiSha256: string;
    };
  };
}

const source = rawTestVectors as unknown as CanonicalTestVectorFile;

if (source.validVectorIdsInOrder.length !== source.vectors.length) {
  throw new Error("Canonical wallet vector IDs and records are not aligned");
}

export const walletProfileTestVectorProfile = source.profile;

export const walletProfileTestVectors: readonly WalletProfileTestVector[] =
  Object.freeze(
    source.vectors.map((vector, index) => Object.freeze({
      id: source.validVectorIdsInOrder[index]!,
      profile: vector.profile,
      diceKeyHumanReadableForm: vector.diceKeyHumanReadableForm,
      allFourRotations: Object.freeze([...vector.allFourRotations]),
      canonicalSeedString: vector.canonicalSeedString,
      recipeUtf8Hex: vector.recipeUtf8Hex,
      derivedEntropyHex: vector.derivedEntropyHex,
      mnemonic: vector.mnemonic,
    })),
  );

export const walletProfileInvalidTestCases:
readonly WalletProfileInvalidTestCase[] = Object.freeze(
  source.invalidCases.map((testCase) => Object.freeze({ ...testCase })),
);

export const walletProfileAcquisitionPolicyCases:
readonly WalletProfileAcquisitionPolicyCase[] = Object.freeze(
  source.acquisitionPolicyCases.map((testCase) => Object.freeze({
    ...testCase,
    candidateHumanReadableForms: Object.freeze([
      ...testCase.candidateHumanReadableForms,
    ]),
  })),
);

export const walletProfileEnglishWordListProvenance = Object.freeze({
  ...source.provenance.bip39EnglishWordList,
});
