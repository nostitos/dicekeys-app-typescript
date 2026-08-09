import rawWalletVectors from "../../../../spec/test-vectors.json";
import rawCheckCodeVectors from "../../../../spec/recovery-profile-check-code-v1-test-vectors.json";

export interface RecoveryProfileCheckCodeTestVector {
  readonly id: string;
  readonly mnemonic: string;
  readonly allFourRotations: readonly string[];
  readonly fullDigestHex: string;
  readonly checkCodeHex: string;
  readonly displayCheckCode: string;
}

interface WalletVectorDocument {
  readonly validVectorIdsInOrder: readonly string[];
  readonly vectors: readonly {
    readonly mnemonic: string;
    readonly allFourRotations: readonly string[];
  }[];
}

interface CheckCodeVectorDocument {
  readonly schema: string;
  readonly schemaVersion: number;
  readonly label: string;
  readonly profile: string;
  readonly domainAscii: string;
  readonly preimagePrefixHex: string;
  readonly digestAlgorithm: string;
  readonly codeByteLength: number;
  readonly vectorCount: number;
  readonly physicalRotationAssociationCount: number;
  readonly vectors: Readonly<Record<string, {
    readonly fullDigestHex: string;
    readonly checkCodeHex: string;
    readonly displayCheckCode: string;
  }>>;
}

const walletDocument = rawWalletVectors as unknown as WalletVectorDocument;
const checkCodeDocument =
  rawCheckCodeVectors as unknown as CheckCodeVectorDocument;

if (
  walletDocument.validVectorIdsInOrder.length !== walletDocument.vectors.length
  || walletDocument.validVectorIdsInOrder.length !== checkCodeDocument.vectorCount
) {
  throw new Error("Wallet and check-code vector counts are not aligned");
}
if (
  walletDocument.validVectorIdsInOrder.join("\n")
  !== Object.keys(checkCodeDocument.vectors).join("\n")
) {
  throw new Error("Wallet and check-code vector IDs are not aligned");
}

export const recoveryProfileCheckCodeVectorMetadata = Object.freeze({
  schema: checkCodeDocument.schema,
  schemaVersion: checkCodeDocument.schemaVersion,
  label: checkCodeDocument.label,
  profile: checkCodeDocument.profile,
  domainAscii: checkCodeDocument.domainAscii,
  preimagePrefixHex: checkCodeDocument.preimagePrefixHex,
  digestAlgorithm: checkCodeDocument.digestAlgorithm,
  codeByteLength: checkCodeDocument.codeByteLength,
  vectorCount: checkCodeDocument.vectorCount,
  physicalRotationAssociationCount:
    checkCodeDocument.physicalRotationAssociationCount,
});

export const recoveryProfileCheckCodeTestVectors:
readonly RecoveryProfileCheckCodeTestVector[] = Object.freeze(
  walletDocument.validVectorIdsInOrder.map((id, index) => {
    const walletVector = walletDocument.vectors[index]!;
    const checkCodeVector = checkCodeDocument.vectors[id];
    if (checkCodeVector == null) {
      throw new Error(`Missing check-code vector ${id}`);
    }
    return Object.freeze({
      id,
      mnemonic: walletVector.mnemonic,
      allFourRotations: Object.freeze([...walletVector.allFourRotations]),
      fullDigestHex: checkCodeVector.fullDigestHex,
      checkCodeHex: checkCodeVector.checkCodeHex,
      displayCheckCode: checkCodeVector.displayCheckCode,
    });
  }),
);
