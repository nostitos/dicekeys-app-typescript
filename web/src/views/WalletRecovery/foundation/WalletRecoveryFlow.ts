import {
  DK_BIP39_24_V1,
  type WalletMnemonicResult,
} from "../../../wallet/DiceKeyBip39ProfileV1";
import { validateWalletDiceKeyFaces } from "../../../wallet/DiceKeyBip39ProfileV1/validate";
import { deriveRecoveryProfileCheckCodeV1 } from "../../../wallet/RecoveryProfileCheckCodeV1";
import type {
  DiceKeyFaces,
} from "../../../dicekeys/DiceKey";
import {
  FaceDigits,
  FaceLetters,
  FaceOrientationLettersTrbl,
} from "../../../dicekeys/DiceKey";
import { selectSixUniqueRecoveryWordPositions } from "./backupChallenge";
import { compareDiceKeysModuloRotation } from "./comparison";
import {
  PHYSICAL_FACE_POSITIONS,
  RECOVERY_WORD_POSITIONS,
  RecoveryTransitionError,
} from "./types";
import type {
  BackupFeedbackCode,
  BackupVerificationMode,
  DeriveRecoveryProfileCheckCode,
  PhysicalFacePosition,
  RecoveryExplanationConsents,
  RecoveryFlowFailureCode,
  RecoveryFlowState,
  RecoveryDiceKeyFace,
  RecoveryWordEntry,
  RecoveryWordPosition,
  SanitizedAcquisitionCleanup,
  SanitizedDiceKeyAcquisition,
  WalletRecoveryFlowDependencies,
} from "./types";

const freezeState = <T extends RecoveryFlowState>(state: T): T =>
  Object.freeze(state);

const validatedFaceSnapshots = new WeakSet<object>();
const validatedSingleFaceSnapshots = new WeakSet<object>();

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate != null;

const readExactOwnDataValues = (
  candidate: object,
  expectedKeys: readonly string[],
): readonly unknown[] | undefined => {
  try {
    const actualKeys = Reflect.ownKeys(candidate);
    if (
      actualKeys.length !== expectedKeys.length ||
      !expectedKeys.every((key) => actualKeys.includes(key))
    ) {
      return undefined;
    }
    const values: unknown[] = [];
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor == null || !("value" in descriptor)) return undefined;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return undefined;
  }
};

export const snapshotStrictWalletRecoveryFace = (
  candidate: unknown,
): RecoveryDiceKeyFace | undefined => {
  if (!isRecord(candidate)) return undefined;
  if (validatedSingleFaceSnapshots.has(candidate)) {
    return candidate as unknown as RecoveryDiceKeyFace;
  }
  const values = readExactOwnDataValues(candidate, [
    "letter",
    "digit",
    "orientationAsLowercaseLetterTrbl",
  ]);
  if (values == null) return undefined;
  const [letter, digit, orientation] = values;
  if (
    typeof letter !== "string" ||
    !FaceLetters.includes(letter as (typeof FaceLetters)[number]) ||
    typeof digit !== "string" ||
    !FaceDigits.includes(digit as (typeof FaceDigits)[number]) ||
    typeof orientation !== "string" ||
    !FaceOrientationLettersTrbl.includes(
      orientation as (typeof FaceOrientationLettersTrbl)[number],
    )
  ) {
    return undefined;
  }
  const snapshot = Object.freeze({
    letter,
    digit,
    orientationAsLowercaseLetterTrbl: orientation,
  }) as RecoveryDiceKeyFace;
  validatedSingleFaceSnapshots.add(snapshot);
  return snapshot;
};

const freezeValidatedFaces = (
  faces: DiceKeyFaces,
): DiceKeyFaces => {
  const snapshot = Object.freeze(faces.map((face) => {
    const strictFace = snapshotStrictWalletRecoveryFace(face);
    if (strictFace == null) {
      throw new TypeError("Validated DiceKey face snapshot was rejected");
    }
    return strictFace;
  })) as unknown as DiceKeyFaces;
  validatedFaceSnapshots.add(snapshot);
  return snapshot;
};

/**
 * Create the one immutable, descriptor-read snapshot used at trust boundaries.
 * Snapshots created here are returned by identity on subsequent validation so
 * an adapter and this flow can share exactly one reviewed-face object without
 * ever trusting ordinary property reads from the original input.
 */
export const snapshotValidatedWalletRecoveryFaces = (
  candidate: unknown,
): DiceKeyFaces | undefined => {
  try {
    if (
      typeof candidate === "object" &&
      candidate != null &&
      validatedFaceSnapshots.has(candidate)
    ) {
      return candidate as DiceKeyFaces;
    }
    if (!Array.isArray(candidate)) return undefined;
    const values = readExactOwnDataValues(candidate, [
      ...Array.from({ length: 25 }, (_, index) => String(index)),
      "length",
    ]);
    if (values == null || values[25] !== 25) return undefined;
    const faces: RecoveryDiceKeyFace[] = [];
    for (let index = 0; index < 25; index += 1) {
      const face = snapshotStrictWalletRecoveryFace(values[index]);
      if (face == null) return undefined;
      faces.push(face);
    }
    return freezeValidatedFaces(
      validateWalletDiceKeyFaces(Object.freeze(faces)),
    );
  } catch {
    return undefined;
  }
};

const snapshotReviewPositions = (
  candidate: unknown,
): readonly PhysicalFacePosition[] | undefined => {
  try {
    if (!Array.isArray(candidate)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "length",
    );
    if (
      lengthDescriptor == null ||
      !("value" in lengthDescriptor) ||
      !Number.isInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 1 ||
      lengthDescriptor.value > 25
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const values = readExactOwnDataValues(candidate, [
      ...Array.from({ length }, (_, index) => String(index)),
      "length",
    ]);
    if (values == null || values[length] !== length) return undefined;
    const uniquePositions = new Set<PhysicalFacePosition>();
    for (let index = 0; index < length; index += 1) {
      const position = values[index];
      if (
        typeof position !== "number" ||
        !Number.isInteger(position) ||
        !PHYSICAL_FACE_POSITIONS.includes(position as PhysicalFacePosition) ||
        uniquePositions.has(position as PhysicalFacePosition)
      ) {
        return undefined;
      }
      uniquePositions.add(position as PhysicalFacePosition);
    }
    return Object.freeze(
      [...uniquePositions].sort((left, right) => left - right),
    );
  } catch {
    return undefined;
  }
};

interface ParsedAcquisition {
  readonly source: object;
  readonly acquisitionId: string;
  readonly faces: DiceKeyFaces;
  readonly confidence: "trusted" | "review-required";
  readonly reviewRequiredPositions: readonly PhysicalFacePosition[];
  readonly dispose: () => void;
  readonly cleanupSettlement: Promise<void>;
}

type AcquisitionCleanup = Pick<
  ParsedAcquisition,
  "dispose" | "cleanupSettlement"
>;

type AcquisitionParseResult =
  | { readonly kind: "valid"; readonly acquisition: ParsedAcquisition }
  | { readonly kind: "invalid-acquisition" }
  | { readonly kind: "invalid-cleanup-settlement" };

const isPromise = (candidate: unknown): candidate is Promise<void> => {
  try {
    return candidate instanceof Promise;
  } catch {
    return false;
  }
};

const parseAcquisitionCleanup = (
  candidate: unknown,
): AcquisitionCleanup | undefined => {
  if (!isRecord(candidate) || Array.isArray(candidate)) return undefined;
  try {
    const values = readExactOwnDataValues(candidate, [
      "acquisitionId",
      "dispose",
      "cleanupSettlement",
    ]);
    if (values == null) return undefined;
    const [acquisitionId, dispose, cleanupSettlement] = values;
    if (
      typeof acquisitionId !== "string" ||
      acquisitionId.length === 0 ||
      acquisitionId.length > 256 ||
      typeof dispose !== "function" ||
      !isPromise(cleanupSettlement)
    ) {
      return undefined;
    }
    return {
      dispose: dispose as () => void,
      cleanupSettlement,
    };
  } catch {
    return undefined;
  }
};

const parseAcquisition = (candidate: unknown): AcquisitionParseResult => {
  if (!isRecord(candidate)) return { kind: "invalid-acquisition" };
  try {
    if (Array.isArray(candidate)) return { kind: "invalid-acquisition" };
    const confidenceDescriptor = Object.getOwnPropertyDescriptor(
      candidate,
      "confidence",
    );
    if (confidenceDescriptor == null || !("value" in confidenceDescriptor)) {
      return { kind: "invalid-acquisition" };
    }
    const confidence = confidenceDescriptor.value;
    if (confidence !== "trusted" && confidence !== "review-required") {
      return { kind: "invalid-acquisition" };
    }
    const keys = confidence === "trusted"
      ? [
          "acquisitionId",
          "faces",
          "confidence",
          "dispose",
          "cleanupSettlement",
        ]
      : [
          "acquisitionId",
          "faces",
          "confidence",
          "reviewRequiredPositions",
          "dispose",
          "cleanupSettlement",
        ];
    const values = readExactOwnDataValues(candidate, keys);
    if (values == null) {
      const cleanupDescriptor = Object.getOwnPropertyDescriptor(
        candidate,
        "cleanupSettlement",
      );
      return cleanupDescriptor == null ||
          !("value" in cleanupDescriptor) ||
          !isPromise(cleanupDescriptor.value)
        ? { kind: "invalid-cleanup-settlement" }
        : { kind: "invalid-acquisition" };
    }
    const acquisitionId = values[0];
    const faces = snapshotValidatedWalletRecoveryFaces(values[1]);
    const dispose = values[values.length - 2];
    const cleanupSettlement = values[values.length - 1];
    if (!isPromise(cleanupSettlement)) {
      return { kind: "invalid-cleanup-settlement" };
    }
    if (
      typeof acquisitionId !== "string" ||
      acquisitionId.length === 0 ||
      acquisitionId.length > 256 ||
      faces == null ||
      typeof dispose !== "function"
    ) {
      return { kind: "invalid-acquisition" };
    }
    const reviewRequiredPositions = confidence === "trusted"
      ? Object.freeze([]) as readonly PhysicalFacePosition[]
      : snapshotReviewPositions(values[3]);
    if (reviewRequiredPositions == null) {
      return { kind: "invalid-acquisition" };
    }
    return {
      kind: "valid",
      acquisition: {
        source: candidate,
        acquisitionId,
        faces,
        confidence,
        reviewRequiredPositions,
        dispose: dispose as () => void,
        cleanupSettlement,
      },
    };
  } catch {
    return { kind: "invalid-acquisition" };
  }
};

const snapshotWordEntries = (
  candidate: unknown,
): readonly RecoveryWordEntry[] | undefined => {
  try {
    if (
      !isRecord(candidate) ||
      !Object.isFrozen(candidate)
    ) {
      return undefined;
    }
    const resultValues = readExactOwnDataValues(
      candidate,
      ["profileId", "words", "mnemonic"],
    );
    if (resultValues == null) return undefined;
    const [profileId, words, mnemonic] = resultValues;
    if (
      profileId !== DK_BIP39_24_V1.id ||
      !Array.isArray(words) ||
      !Object.isFrozen(words) ||
      typeof mnemonic !== "string"
    ) {
      return undefined;
    }
    const wordValues = readExactOwnDataValues(words, [
        ...Array.from({ length: 24 }, (_, index) => String(index)),
        "length",
      ]);
    if (wordValues == null || wordValues[24] !== 24) return undefined;

    const cleanWords: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const word = wordValues[index];
      if (typeof word !== "string" || !/^[a-z]+$/.test(word)) {
        return undefined;
      }
      cleanWords.push(word);
    }
    if (cleanWords.join(" ") !== mnemonic) return undefined;

    return Object.freeze(
      RECOVERY_WORD_POSITIONS.map((position, index) => Object.freeze({
        position,
        word: cleanWords[index]!,
      })),
    );
  } catch {
    return undefined;
  }
};

const normalizeEnteredWord = (word: unknown): string | undefined =>
  typeof word === "string" ? word.trim().toLowerCase() : undefined;

type RecoveryFlowStateWithoutEpoch = RecoveryFlowState extends infer State
  ? State extends RecoveryFlowState
    ? Omit<State, "epoch">
    : never
  : never;

const positionsAreExactly = (
  entries: readonly RecoveryWordEntry[],
  expectedPositions: readonly RecoveryWordPosition[],
): boolean => {
  if (entries.length !== expectedPositions.length) return false;
  const receivedPositions = entries.map(({ position }) => position);
  return expectedPositions.every(
    (position) => receivedPositions.filter(
      (receivedPosition) => receivedPosition === position,
    ).length === 1,
  );
};

/**
 * A narrow, framework-free coordinator for the wallet recovery ceremony.
 * Scanner and crypto implementations are injected by an adapter at the edge.
 */
export class WalletRecoveryFlow {
  private readonly dependencies: WalletRecoveryFlowDependencies;
  private readonly deriveRecoveryProfileCheckCode:
    DeriveRecoveryProfileCheckCode;
  private currentEpoch = 0;
  private currentState: RecoveryFlowState = freezeState({
    kind: "explain",
    epoch: 0,
  });

  private firstFaces: DiceKeyFaces | undefined;
  private secondFaces: DiceKeyFaces | undefined;
  private firstAcquisitionId: string | undefined;
  private activeAcquisitionCleanup: AcquisitionCleanup | undefined;
  private wordEntries: readonly RecoveryWordEntry[] | undefined;
  private profileId: string | undefined;
  private checkCode: string | undefined;
  private inFlightDerivation: Promise<void> | undefined;
  private readonly seenAcquisitions = new WeakSet<object>();

  public constructor(dependencies: WalletRecoveryFlowDependencies) {
    this.dependencies = dependencies;
    this.deriveRecoveryProfileCheckCode =
      dependencies.deriveRecoveryProfileCheckCode ??
      deriveRecoveryProfileCheckCodeV1;
  }

  public get state(): RecoveryFlowState {
    return this.currentState;
  }

  public acceptExplanation(consents: RecoveryExplanationConsents): void {
    this.requireState("explain");
    if (
      consents.computerIsOfflineAndTrusted !== true ||
      consents.understandsWordsControlWallet !== true ||
      consents.willRetainProfileWithPhysicalDiceKey !== true
    ) {
      throw new RecoveryTransitionError("CONSENT_REQUIRED");
    }
    this.transition({ kind: "awaiting-first-acquisition" });
  }

  /**
   * Returns false for a stale scanner callback.  Stale acquisitions are always
   * disposed and can never change an advanced or cleared flow.
   */
  public receiveAcquisition(
    expectedEpoch: number,
    acquisition: SanitizedDiceKeyAcquisition,
  ): boolean {
    if (
      expectedEpoch !== this.currentEpoch ||
      (this.currentState.kind !== "awaiting-first-acquisition" &&
        this.currentState.kind !== "awaiting-second-acquisition")
    ) {
      this.disposeDetachedAcquisition(acquisition);
      return false;
    }

    const stage = this.currentState.kind === "awaiting-first-acquisition"
      ? "first"
      : "second";
    const parseResult = parseAcquisition(acquisition);
    if (parseResult.kind !== "valid") {
      const failureContext: { epoch?: number } = {};
      const disposalSucceeded = this.disposeDetachedAcquisition(
        acquisition,
        () => {
          if (failureContext.epoch != null) {
            this.replaceCurrentFailureWithDisposalFailure(
              failureContext.epoch,
            );
          }
        },
      );
      this.fail(
        disposalSucceeded &&
          parseResult.kind !== "invalid-cleanup-settlement"
          ? "INVALID_ACQUISITION"
          : "ACQUISITION_DISPOSAL_FAILED",
      );
      failureContext.epoch = this.currentEpoch;
      return true;
    }
    const parsed = parseResult.acquisition;

    if (
      stage === "second" &&
      (parsed.acquisitionId === this.firstAcquisitionId ||
        this.seenAcquisitions.has(parsed.source))
    ) {
      const failureContext: { epoch?: number } = {};
      const disposalSucceeded = this.disposeDetachedAcquisition(
        acquisition,
        () => {
          if (failureContext.epoch != null) {
            this.replaceCurrentFailureWithDisposalFailure(
              failureContext.epoch,
            );
          }
        },
      );
      this.fail(
        disposalSucceeded
          ? "ACQUISITION_REUSED"
          : "ACQUISITION_DISPOSAL_FAILED",
      );
      failureContext.epoch = this.currentEpoch;
      return true;
    }

    if (stage === "first") {
      this.firstFaces = parsed.faces;
      this.firstAcquisitionId = parsed.acquisitionId;
    } else {
      this.secondFaces = parsed.faces;
    }
    this.seenAcquisitions.add(parsed.source);
    this.activeAcquisitionCleanup = {
      dispose: parsed.dispose,
      cleanupSettlement: parsed.cleanupSettlement,
    };

    if (parsed.confidence === "trusted") {
      this.completeCurrentAcquisition(stage);
    } else {
      this.transition({
        kind: stage === "first"
          ? "reviewing-first-acquisition"
          : "reviewing-second-acquisition",
        reviewRequiredPositions: parsed.reviewRequiredPositions,
        reviewedPositions: Object.freeze([]),
      });
    }
    return true;
  }

  /**
   * Ends an in-progress scanner acquisition with one fixed, payload-free code.
   * The attempt cleanup handle is still owned and observed so disposal failure
   * cannot be mistaken for a successfully released scanner.
   */
  public receiveAcquisitionFailure(
    expectedEpoch: number,
    cleanup: SanitizedAcquisitionCleanup,
  ): boolean {
    if (
      expectedEpoch !== this.currentEpoch ||
      (this.currentState.kind !== "awaiting-first-acquisition" &&
        this.currentState.kind !== "awaiting-second-acquisition")
    ) {
      this.disposeDetachedAcquisition(cleanup);
      return false;
    }

    const parsedCleanup = parseAcquisitionCleanup(cleanup);
    if (parsedCleanup == null) {
      this.disposeDetachedAcquisition(cleanup);
      this.fail("ACQUISITION_DISPOSAL_FAILED");
      return true;
    }
    this.activeAcquisitionCleanup = parsedCleanup;
    this.fail("ACQUISITION_FAILED");
    return true;
  }

  public reviewFace(
    position: PhysicalFacePosition,
    correctedFace?: RecoveryDiceKeyFace,
  ): void {
    if (
      this.currentState.kind !== "reviewing-first-acquisition" &&
      this.currentState.kind !== "reviewing-second-acquisition"
    ) {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
    if (!this.currentState.reviewRequiredPositions.includes(position)) {
      throw new RecoveryTransitionError("POSITION_NOT_REVIEWABLE");
    }
    let corrected = false;
    if (correctedFace !== undefined) {
      const cleanCorrection = snapshotStrictWalletRecoveryFace(correctedFace);
      if (cleanCorrection == null) {
        this.fail("INVALID_ACQUISITION");
        return;
      }
      const faces = this.currentState.kind === "reviewing-first-acquisition"
        ? this.firstFaces
        : this.secondFaces;
      if (faces == null) {
        this.fail("INVALID_ACQUISITION");
        return;
      }
      const correctedFaces = Object.freeze(
        faces.map((face, index) =>
          index === position - 1 ? cleanCorrection : face),
      ) as unknown as DiceKeyFaces;
      if (this.currentState.kind === "reviewing-first-acquisition") {
        this.firstFaces = correctedFaces;
      } else {
        this.secondFaces = correctedFaces;
      }
      corrected = true;
    }
    if (
      !corrected &&
      this.currentState.reviewedPositions.includes(position)
    ) {
      return;
    }

    this.transition({
      kind: this.currentState.kind,
      reviewRequiredPositions: this.currentState.reviewRequiredPositions,
      reviewedPositions: this.currentState.reviewedPositions.includes(position)
        ? this.currentState.reviewedPositions
        : Object.freeze([
            ...this.currentState.reviewedPositions,
            position,
          ].sort((left, right) => left - right)),
    });
  }

  public completeAcquisitionReview(): void {
    if (
      this.currentState.kind !== "reviewing-first-acquisition" &&
      this.currentState.kind !== "reviewing-second-acquisition"
    ) {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
    if (
      this.currentState.reviewedPositions.length !==
      this.currentState.reviewRequiredPositions.length
    ) {
      throw new RecoveryTransitionError("REVIEW_INCOMPLETE");
    }
    const stage = this.currentState.kind === "reviewing-first-acquisition"
      ? "first"
      : "second";
    if (!this.revalidateReviewedFaces(stage)) return;
    this.completeCurrentAcquisition(stage);
  }

  public acknowledgePhysicalBreak(): void {
    this.requireState("awaiting-physical-break");
    this.transition({ kind: "awaiting-second-acquisition" });
  }

  /** Starts at most one derivation and returns the same promise on double activation. */
  public beginDerivation(): Promise<void> {
    if (this.currentState.kind === "deriving" && this.inFlightDerivation != null) {
      return this.inFlightDerivation;
    }
    this.requireState("matched");
    let facesForDerivation = this.firstFaces;
    if (facesForDerivation == null) {
      this.fail("INVALID_ACQUISITION");
      return Promise.resolve();
    }

    this.transition({ kind: "deriving" });
    const derivationEpoch = this.currentEpoch;

    // Remove both acquisition arrays from machine state synchronously before
    // any injected async derivation work starts.
    this.firstFaces = undefined;
    this.secondFaces = undefined;
    this.firstAcquisitionId = undefined;

    let resultPromise: Promise<WalletMnemonicResult>;
    try {
      resultPromise = this.dependencies.deriveWalletMnemonic(
        facesForDerivation,
      );
    } catch {
      facesForDerivation = undefined;
      if (this.operationIsCurrent(derivationEpoch, "deriving")) {
        this.fail("DERIVATION_FAILED");
      }
      return Promise.resolve();
    }
    facesForDerivation = undefined;

    const inFlight = this.completeDerivation(resultPromise, derivationEpoch);
    this.inFlightDerivation = inFlight;
    const clearInFlightReference = (): void => {
      if (this.inFlightDerivation === inFlight) {
        this.inFlightDerivation = undefined;
      }
    };
    void inFlight.then(clearInFlightReference, clearInFlightReference);
    return inFlight;
  }

  public reveal(): void {
    this.requireState("concealed");
    const { wordEntries, profileId, checkCode } = this.requireRecoveryMaterial();
    this.transition({
      kind: "revealed",
      profileId,
      checkCode,
      wordEntries,
    });
  }

  public continueToBackupChoice(): void {
    this.requireState("revealed");
    const { profileId, checkCode } = this.requireRecoveryMaterial();
    this.transition({
      kind: "backup-choice",
      profileId,
      checkCode,
    });
  }

  public chooseBackupVerification(mode: BackupVerificationMode): void {
    if (mode !== "six-word-challenge" && mode !== "full-entry") {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
    if (
      this.currentState.kind !== "backup-choice" &&
      this.currentState.kind !== "six-word-challenge" &&
      this.currentState.kind !== "full-entry"
    ) {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
    const { profileId, checkCode } = this.requireRecoveryMaterial();
    if (mode === "six-word-challenge") {
      const positions = selectSixUniqueRecoveryWordPositions(
        this.dependencies.getRandomValues,
      );
      this.transition({
        kind: "six-word-challenge",
        profileId,
        checkCode,
        positions,
      });
    } else {
      this.transition({ kind: "full-entry", profileId, checkCode });
    }
  }

  public returnToBackupChoice(): void {
    if (
      this.currentState.kind !== "six-word-challenge" &&
      this.currentState.kind !== "full-entry"
    ) {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
    const { profileId, checkCode } = this.requireRecoveryMaterial();
    this.transition({
      kind: "backup-choice",
      profileId,
      checkCode,
    });
  }

  public submitSixWordChallenge(
    entries: readonly RecoveryWordEntry[],
  ): boolean {
    if (this.currentState.kind !== "six-word-challenge") {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
    const expectedPositions = this.currentState.positions;
    if (!positionsAreExactly(entries, expectedPositions)) {
      this.setBackupFeedback("BACKUP_ENTRY_INCOMPLETE");
      return false;
    }
    if (!this.entriesMatch(entries)) {
      this.setBackupFeedback("BACKUP_WORD_MISMATCH");
      return false;
    }
    this.markVerified("six-word-challenge");
    return true;
  }

  public submitFullEntry(entries: readonly RecoveryWordEntry[]): boolean {
    this.requireState("full-entry");
    if (!positionsAreExactly(entries, RECOVERY_WORD_POSITIONS)) {
      this.setBackupFeedback("BACKUP_ENTRY_INCOMPLETE");
      return false;
    }
    if (!this.entriesMatch(entries)) {
      this.setBackupFeedback("BACKUP_WORD_MISMATCH");
      return false;
    }
    this.markVerified("full-entry");
    return true;
  }

  /** Clear is legal from every state and the cleared state is absorbing. */
  public clear(): void {
    if (this.currentState.kind === "cleared") return;
    this.currentEpoch += 1;
    this.inFlightDerivation = undefined;
    const cleanup = this.takeActiveAcquisitionCleanup();
    this.discardRecoveryMaterial();
    this.firstFaces = undefined;
    this.secondFaces = undefined;
    this.firstAcquisitionId = undefined;
    this.currentState = freezeState({
      kind: "cleared",
      epoch: this.currentEpoch,
    });
    this.disposeDetachedCleanup(cleanup);
  }

  public dispose(): void {
    this.clear();
  }

  private transition(
    next: RecoveryFlowStateWithoutEpoch,
  ): void {
    if (this.currentState.kind === "cleared") return;
    this.currentEpoch += 1;
    this.currentState = freezeState({
      ...next,
      epoch: this.currentEpoch,
    } as RecoveryFlowState);
  }

  private requireState<K extends RecoveryFlowState["kind"]>(kind: K): void {
    if (this.currentState.kind !== kind) {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
  }

  private completeCurrentAcquisition(stage: "first" | "second"): void {
    const cleanup = this.takeActiveAcquisitionCleanup();
    if (cleanup == null) {
      this.fail("ACQUISITION_DISPOSAL_FAILED");
      return;
    }

    const releasingKind = stage === "first"
      ? "releasing-first-acquisition"
      : "releasing-second-acquisition";
    // Claim a new epoch before invoking caller-controlled disposal. A disposer
    // may synchronously re-enter the flow, but it can no longer submit another
    // acquisition into the stage that this cleanup is releasing.
    this.transition({ kind: releasingKind });
    const releaseEpoch = this.currentEpoch;
    try {
      cleanup.dispose();
    } catch {
      this.observeCleanupSettlement(cleanup.cleanupSettlement);
      if (this.operationIsCurrent(releaseEpoch, releasingKind)) {
        this.fail("ACQUISITION_DISPOSAL_FAILED");
      }
      return;
    }

    if (!this.operationIsCurrent(releaseEpoch, releasingKind)) {
      this.observeCleanupSettlement(cleanup.cleanupSettlement);
      return;
    }
    if (!this.observeCleanupSettlement(
      cleanup.cleanupSettlement,
      () => this.completeCurrentAcquisitionRelease(stage, releaseEpoch),
      () => {
        if (this.operationIsCurrent(releaseEpoch, releasingKind)) {
          this.fail("ACQUISITION_DISPOSAL_FAILED");
        }
      },
    )) {
      this.fail("ACQUISITION_DISPOSAL_FAILED");
    }
  }

  private completeCurrentAcquisitionRelease(
    stage: "first" | "second",
    releaseEpoch: number,
  ): void {
    const releasingKind = stage === "first"
      ? "releasing-first-acquisition"
      : "releasing-second-acquisition";
    if (!this.operationIsCurrent(releaseEpoch, releasingKind)) return;

    if (stage === "first") {
      this.transition({
        kind: "awaiting-physical-break",
        firstAcquisitionDisposed: true,
      });
      return;
    }

    const firstFaces = this.firstFaces;
    const secondFaces = this.secondFaces;
    if (firstFaces == null || secondFaces == null) {
      this.fail("INVALID_ACQUISITION");
      return;
    }

    let comparison: ReturnType<typeof compareDiceKeysModuloRotation>;
    try {
      comparison = compareDiceKeysModuloRotation(firstFaces, secondFaces);
    } catch {
      this.fail("INVALID_ACQUISITION");
      return;
    }
    if (comparison.kind === "match") {
      this.transition({
        kind: "matched",
        rotation: comparison.rotation,
      });
    } else if (comparison.kind === "mismatch") {
      this.firstFaces = undefined;
      this.secondFaces = undefined;
      this.firstAcquisitionId = undefined;
      this.transition({
        kind: "mismatch",
        comparison,
      });
    } else {
      this.firstFaces = undefined;
      this.secondFaces = undefined;
      this.firstAcquisitionId = undefined;
      this.transition({
        kind: "alignment-ambiguous",
        comparison,
      });
    }
  }

  private revalidateReviewedFaces(stage: "first" | "second"): boolean {
    const candidate = stage === "first" ? this.firstFaces : this.secondFaces;
    const validated = snapshotValidatedWalletRecoveryFaces(candidate);
    if (validated == null) {
      this.fail("INVALID_ACQUISITION");
      return false;
    }
    if (stage === "first") {
      this.firstFaces = validated;
    } else {
      this.secondFaces = validated;
    }
    return true;
  }

  private async completeDerivation(
    resultPromise: Promise<WalletMnemonicResult>,
    derivationEpoch: number,
  ): Promise<void> {
    let result: WalletMnemonicResult;
    try {
      result = await resultPromise;
    } catch {
      if (this.operationIsCurrent(derivationEpoch, "deriving")) {
        this.fail("DERIVATION_FAILED");
      }
      return;
    }
    if (!this.operationIsCurrent(derivationEpoch, "deriving")) return;

    let entries = snapshotWordEntries(result);
    if (entries == null) {
      this.fail("INVALID_DERIVATION_RESULT");
      return;
    }

    let derivedCheckCode: string;
    try {
      derivedCheckCode = await this.deriveRecoveryProfileCheckCode(result);
    } catch {
      if (this.operationIsCurrent(derivationEpoch, "deriving")) {
        this.fail("CHECK_CODE_FAILED");
      }
      return;
    }
    if (!this.operationIsCurrent(derivationEpoch, "deriving")) return;

    // Re-read the result after the await so a mutable injected test double
    // cannot change the words between check-code computation and display.
    entries = snapshotWordEntries(result);
    if (entries == null) {
      this.fail("INVALID_DERIVATION_RESULT");
      return;
    }
    if (
      typeof derivedCheckCode !== "string" ||
      !/^[0-9A-F]{4}(?:-[0-9A-F]{4}){2}$/.test(derivedCheckCode)
    ) {
      this.fail("INVALID_CHECK_CODE");
      return;
    }

    this.wordEntries = entries;
    this.profileId = DK_BIP39_24_V1.id;
    this.checkCode = derivedCheckCode;
    this.transition({
      kind: "concealed",
      profileId: DK_BIP39_24_V1.id,
      checkCode: derivedCheckCode,
    });
  }

  private operationIsCurrent(
    operationEpoch: number,
    kind: RecoveryFlowState["kind"],
  ): boolean {
    return this.currentEpoch === operationEpoch && this.currentState.kind === kind;
  }

  private requireRecoveryMaterial(): {
    readonly wordEntries: readonly RecoveryWordEntry[];
    readonly profileId: string;
    readonly checkCode: string;
  } {
    if (
      this.wordEntries == null ||
      this.profileId == null ||
      this.checkCode == null
    ) {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
    return {
      wordEntries: this.wordEntries,
      profileId: this.profileId,
      checkCode: this.checkCode,
    };
  }

  private entriesMatch(entries: readonly RecoveryWordEntry[]): boolean {
    const expectedEntries = this.wordEntries;
    if (expectedEntries == null) return false;
    return entries.every(({ position, word }) => {
      const normalizedWord = normalizeEnteredWord(word);
      return normalizedWord != null &&
        expectedEntries[position - 1]?.word === normalizedWord;
    });
  }

  private setBackupFeedback(code: BackupFeedbackCode): void {
    if (this.currentState.kind === "six-word-challenge") {
      this.transition({
        kind: "six-word-challenge",
        profileId: this.currentState.profileId,
        checkCode: this.currentState.checkCode,
        positions: this.currentState.positions,
        feedbackCode: code,
      });
    } else if (this.currentState.kind === "full-entry") {
      this.transition({
        kind: "full-entry",
        profileId: this.currentState.profileId,
        checkCode: this.currentState.checkCode,
        feedbackCode: code,
      });
    } else {
      throw new RecoveryTransitionError("ILLEGAL_TRANSITION");
    }
  }

  private markVerified(method: BackupVerificationMode): void {
    const { profileId, checkCode } = this.requireRecoveryMaterial();
    this.wordEntries = undefined;
    this.transition({ kind: "verified", profileId, checkCode, method });
  }

  private takeActiveAcquisitionCleanup(): AcquisitionCleanup | undefined {
    const cleanup = this.activeAcquisitionCleanup;
    this.activeAcquisitionCleanup = undefined;
    return cleanup;
  }

  private observeCleanupSettlement(
    settlement: Promise<void>,
    onFulfilled: () => void = () => undefined,
    onRejected: () => void = () => undefined,
  ): boolean {
    try {
      void Promise.prototype.then.call(
        settlement,
        onFulfilled,
        onRejected,
      );
      return true;
    } catch {
      return false;
    }
  }

  private disposeDetachedCleanup(
    cleanup: AcquisitionCleanup | undefined,
  ): boolean {
    if (cleanup == null) return true;
    let disposalSucceeded = true;
    try {
      cleanup.dispose();
    } catch {
      disposalSucceeded = false;
    }
    return this.observeCleanupSettlement(cleanup.cleanupSettlement) &&
      disposalSucceeded;
  }

  private disposeDetachedAcquisition(
    acquisition: unknown,
    onSettlementRejected: () => void = () => undefined,
  ): boolean {
    try {
      if (!isRecord(acquisition)) return true;
      const disposeDescriptor = Object.getOwnPropertyDescriptor(
        acquisition,
        "dispose",
      );
      const settlementDescriptor = Object.getOwnPropertyDescriptor(
        acquisition,
        "cleanupSettlement",
      );
      const cleanupSettlement =
        settlementDescriptor != null &&
        "value" in settlementDescriptor &&
        isPromise(settlementDescriptor.value)
          ? settlementDescriptor.value
          : undefined;
      const settlementObserved = cleanupSettlement != null &&
        this.observeCleanupSettlement(
          cleanupSettlement,
          undefined,
          onSettlementRejected,
        );
      if (
        disposeDescriptor == null ||
        !("value" in disposeDescriptor) ||
        typeof disposeDescriptor.value !== "function"
      ) {
        // A malformed acquisition can still carry a real cleanup promise.
        // Observe it before rejecting the unusable disposer so stale or
        // hostile callbacks cannot create an unhandled rejection.
        return false;
      }
      let disposalSucceeded = true;
      try {
        (disposeDescriptor.value as () => void)();
      } catch {
        disposalSucceeded = false;
      }
      return settlementObserved && disposalSucceeded;
    } catch {
      return false;
    }
  }

  private fail(code: RecoveryFlowFailureCode): void {
    const cleanup = this.takeActiveAcquisitionCleanup();
    this.firstFaces = undefined;
    this.secondFaces = undefined;
    this.firstAcquisitionId = undefined;
    this.discardRecoveryMaterial();
    this.transition({ kind: "failed", code });
    const failureEpoch = this.currentEpoch;
    if (cleanup == null) return;
    let disposalSucceeded = true;
    try {
      cleanup.dispose();
    } catch {
      disposalSucceeded = false;
    }
    const observed = this.observeCleanupSettlement(
      cleanup.cleanupSettlement,
      undefined,
      () => this.replaceCurrentFailureWithDisposalFailure(failureEpoch),
    );
    if (!disposalSucceeded || !observed) {
      this.replaceCurrentFailureWithDisposalFailure(failureEpoch);
    }
  }

  private replaceCurrentFailureWithDisposalFailure(
    failureEpoch: number,
  ): void {
    if (!this.operationIsCurrent(failureEpoch, "failed")) return;
    if (
      this.currentState.kind === "failed" &&
      this.currentState.code === "ACQUISITION_DISPOSAL_FAILED"
    ) {
      return;
    }
    this.transition({ kind: "failed", code: "ACQUISITION_DISPOSAL_FAILED" });
  }

  private discardRecoveryMaterial(): void {
    this.wordEntries = undefined;
    this.profileId = undefined;
    this.checkCode = undefined;
  }
}
