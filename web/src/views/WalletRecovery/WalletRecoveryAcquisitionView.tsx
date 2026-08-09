import { observer } from "mobx-react";
import React, { useEffect, useMemo, useState } from "react";

import {
  FaceDigits,
  FaceLetters,
  FaceOrientationLettersTrbl,
} from "../../dicekeys/DiceKey";
import { ScanDiceKeyView } from "../LoadingDiceKeys/ScanDiceKeyView";
import type { WalletRecoveryRescanReason } from "../LoadingDiceKeys/wallet-recovery-scanner-policy";
import type {
  FaceDifference,
  PhysicalFacePosition,
  RecoveryDiceKeyFace,
  RecoveryFlowState,
} from "./foundation";
import { WalletRecoveryViewState } from "./WalletRecoveryViewState";
import {
  ActionBar,
  BodyText,
  Callout,
  DifferenceItem,
  DifferenceList,
  DifferenceNumber,
  FaceEditor,
  FacePositionButton,
  FacePositionGrid,
  FaceReviewLayout,
  FieldGrid,
  FieldLabel,
  Heading,
  IndeterminateRule,
  Kicker,
  Lead,
  Panel,
  PanelHeader,
  PrimaryButton,
  ScannerFrame,
  ScannerStage,
  Select,
  Stack,
  StatusMark,
  Subheading,
  WidePanel,
} from "./WalletRecoveryStyles";

interface WalletRecoveryAcquisitionViewProps {
  readonly state: WalletRecoveryViewState;
  readonly onExit: () => void;
  readonly onRestart: () => void;
}

type AcquisitionState = Extract<
  RecoveryFlowState,
  {
    readonly kind:
      | "awaiting-first-acquisition"
      | "reviewing-first-acquisition"
      | "releasing-first-acquisition"
      | "awaiting-physical-break"
      | "awaiting-second-acquisition"
      | "reviewing-second-acquisition"
      | "releasing-second-acquisition"
      | "matched"
      | "mismatch"
      | "alignment-ambiguous";
  }
>;

const rescanMessages: Readonly<Record<WalletRecoveryRescanReason, string>> = {
  incomplete: "The camera did not capture all 25 faces. Keep the whole DiceKey inside the guide.",
  malformed: "That frame could not be read safely. Reposition the DiceKey and try again.",
  "no-majority": "Some faces did not produce one clear reading. Hold the camera steady and try again.",
  "ocr-ambiguous": "Some letters or digits are ambiguous. Improve the light and try again.",
  "unsupported-scanner-error": "The scanner reported an unsupported uncertainty. A clean rescan is required.",
  "strict-wallet-invalid": "That reading is not a valid unique-letter DiceKey for wallet recovery. Check the complete key and rescan.",
};

const orientationLabels = Object.freeze({
  t: "up",
  r: "right",
  b: "down",
  l: "left",
} as const);

const ScannerSessionGateNotice = observer(({
  state,
}: {
  readonly state: WalletRecoveryViewState;
}) => {
  switch (state.sessionGateStatus) {
    case "idle":
      return null;
    case "pending":
      return (
        <Callout role="status" aria-live="polite">
          This scanner session is active or cleaning up. A new recovery ceremony cannot start until cleanup is confirmed.
        </Callout>
      );
    case "unconfirmed":
      return (
        <Callout $tone="danger" role="alert">
          Scanner cleanup could not be confirmed. Exit now, then close and reload this page or app before attempting wallet recovery again.
        </Callout>
      );
  }
});

const ScanPanel = observer(({
  state,
  flowState,
  onExit,
}: WalletRecoveryAcquisitionViewProps & {
  readonly flowState: Extract<
    AcquisitionState,
    { readonly kind: "awaiting-first-acquisition" | "awaiting-second-acquisition" }
  >;
}) => {
  const scanNumber = flowState.kind === "awaiting-first-acquisition" ? 1 : 2;
  const scannerCallback = useMemo(
    () => state.walletScannerCallbackForCurrentAttempt(),
    [state, state.scannerAttemptKey],
  );

  return (
    <WidePanel aria-labelledby="recovery-scan-heading">
      <PanelHeader>
        <Kicker>Scan {scanNumber} of 2</Kicker>
        <Heading id="recovery-scan-heading">
          {scanNumber === 1 ? "Read the complete DiceKey" : "Make the independent second reading"}
        </Heading>
        <Lead>
          Keep all 25 faces inside the guide. The wallet scanner will not use an incomplete or uncertain best guess.
        </Lead>
      </PanelHeader>
      <ScannerStage>
        <ScannerSessionGateNotice state={state} />
        {state.rescanReason == null ? null : (
          <Callout $tone="warning" role="alert">
            {rescanMessages[state.rescanReason]}
          </Callout>
        )}
        <ScannerFrame>
          <ScanDiceKeyView
            key={state.scannerAttemptKey}
            height="100%"
            showBoxOverlay={true}
            scanMode="wallet-recovery"
            onWalletRecoveryAttemptStarted={state.registerWalletScannerAttempt}
            onWalletRecoveryScan={scannerCallback}
            onExit={onExit}
          />
        </ScannerFrame>
        <BodyText>
          Use even light, avoid glare, and keep the camera parallel to the DiceKey.
        </BodyText>
      </ScannerStage>
    </WidePanel>
  );
});

const FaceReviewForm = ({
  face,
  position,
  onConfirm,
}: {
  readonly face: RecoveryDiceKeyFace;
  readonly position: PhysicalFacePosition;
  readonly onConfirm: (face: RecoveryDiceKeyFace) => void;
}) => {
  const [letter, setLetter] = useState(face.letter);
  const [digit, setDigit] = useState(face.digit);
  const [orientation, setOrientation] = useState(
    face.orientationAsLowercaseLetterTrbl,
  );

  useEffect(() => {
    setLetter(face.letter);
    setDigit(face.digit);
    setOrientation(face.orientationAsLowercaseLetterTrbl);
  }, [face, position]);

  return (
    <FaceEditor
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm({
          letter,
          digit,
          orientationAsLowercaseLetterTrbl: orientation,
        });
      }}
    >
      <Subheading>Review position {position}</Subheading>
      <BodyText>
        Confirm the camera reading or correct the face before continuing.
      </BodyText>
      <FieldGrid>
        <FieldLabel>
          Letter
          <Select
            aria-label={`Letter at position ${position}`}
            value={letter}
            onChange={(event) => setLetter(
              event.currentTarget.value as RecoveryDiceKeyFace["letter"],
            )}
          >
            {FaceLetters.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </Select>
        </FieldLabel>
        <FieldLabel>
          Digit
          <Select
            aria-label={`Digit at position ${position}`}
            value={digit}
            onChange={(event) => setDigit(
              event.currentTarget.value as RecoveryDiceKeyFace["digit"],
            )}
          >
            {FaceDigits.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </Select>
        </FieldLabel>
        <FieldLabel>
          Direction
          <Select
            aria-label={`Direction at position ${position}`}
            value={orientation}
            onChange={(event) => setOrientation(
              event.currentTarget.value as RecoveryDiceKeyFace["orientationAsLowercaseLetterTrbl"],
            )}
          >
            {FaceOrientationLettersTrbl.map((candidate) => (
              <option key={candidate} value={candidate}>
                {orientationLabels[candidate]}
              </option>
            ))}
          </Select>
        </FieldLabel>
      </FieldGrid>
      <PrimaryButton type="submit">Confirm position {position}</PrimaryButton>
    </FaceEditor>
  );
};

const ReviewPanel = observer(({
  state,
  flowState,
}: {
  readonly state: WalletRecoveryViewState;
  readonly flowState: Extract<
    AcquisitionState,
    { readonly kind: "reviewing-first-acquisition" | "reviewing-second-acquisition" }
  >;
}) => {
  const scanNumber = flowState.kind === "reviewing-first-acquisition" ? 1 : 2;
  const firstUnreviewed = flowState.reviewRequiredPositions.find(
    (position) => !flowState.reviewedPositions.includes(position),
  ) ?? flowState.reviewRequiredPositions[0];
  const [selectedPosition, setSelectedPosition] = useState(firstUnreviewed);

  useEffect(() => {
    setSelectedPosition(firstUnreviewed);
  }, [flowState.epoch, firstUnreviewed]);

  const faces = state.reviewFaces;
  const selectedFace = selectedPosition == null
    ? undefined
    : faces?.[selectedPosition - 1];
  const reviewComplete =
    flowState.reviewedPositions.length === flowState.reviewRequiredPositions.length;

  return (
    <WidePanel aria-labelledby="recovery-review-heading">
      <PanelHeader>
        <Kicker>Scan {scanNumber} review</Kicker>
        <Heading id="recovery-review-heading">Check every flagged face</Heading>
        <Lead>
          Only the outlined positions need attention. Confirm what is physically printed on the DiceKey, not what you expect to see.
        </Lead>
      </PanelHeader>
      {state.inlineErrorCode === "REVIEW_INCOMPLETE" ? (
        <Callout $tone="warning" role="alert">
          Confirm every flagged face before finishing this scan review.
        </Callout>
      ) : state.inlineErrorCode === "POSITION_NOT_REVIEWABLE" ? (
        <Callout $tone="warning" role="alert">
          Only a position flagged by this scanner attempt can be reviewed or corrected.
        </Callout>
      ) : null}
      {faces == null || selectedFace == null || selectedPosition == null ? (
        <Callout $tone="danger" role="alert">
          The reviewed scan is no longer available. Clear this attempt and start again.
        </Callout>
      ) : (
        <FaceReviewLayout>
          <Stack>
            <FacePositionGrid aria-label="DiceKey face review positions">
              {faces.map((face, index) => {
                const position = index + 1 as PhysicalFacePosition;
                const reviewRequired = flowState.reviewRequiredPositions.includes(position);
                const reviewed = flowState.reviewedPositions.includes(position);
                const isSelected = selectedPosition === position;
                return (
                  <FacePositionButton
                    key={position}
                    type="button"
                    data-position={position}
                    $active={isSelected && reviewRequired}
                    $reviewed={reviewed}
                    disabled={!reviewRequired}
                    aria-label={reviewRequired
                      ? `Review position ${position}, ${face.letter}${face.digit}, facing ${orientationLabels[face.orientationAsLowercaseLetterTrbl]}`
                      : `Position ${position}, no review required`}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedPosition(position)}
                  >
                    <span aria-hidden="true">{face.letter}{face.digit}</span>
                  </FacePositionButton>
                );
              })}
            </FacePositionGrid>
            <Callout role="status" aria-live="polite">
              {flowState.reviewedPositions.length} of {flowState.reviewRequiredPositions.length} flagged positions confirmed
            </Callout>
          </Stack>
          <FaceReviewForm
            face={selectedFace}
            position={selectedPosition}
            onConfirm={(correctedFace) => {
              const transitioned = state.reviewFace(selectedPosition, correctedFace);
              if (!transitioned) return;
              const nextPosition = flowState.reviewRequiredPositions.find(
                (position) => position !== selectedPosition &&
                  !flowState.reviewedPositions.includes(position),
              );
              if (nextPosition != null) setSelectedPosition(nextPosition);
            }}
          />
        </FaceReviewLayout>
      )}
      <ActionBar>
        <PrimaryButton
          disabled={!reviewComplete}
          onClick={state.completeAcquisitionReview}
        >
          Finish scan {scanNumber} review
        </PrimaryButton>
      </ActionBar>
    </WidePanel>
  );
});

const ReleasingPanel = ({ scanNumber }: { readonly scanNumber: 1 | 2 }) => (
  <Panel role="status" aria-live="polite" aria-busy="true">
    <PanelHeader>
      <Kicker>Scan {scanNumber} complete</Kicker>
      <Heading>Closing the camera safely</Heading>
      <Lead>
        The next step stays locked until this scanner attempt confirms that its resources were released.
      </Lead>
    </PanelHeader>
    <IndeterminateRule />
  </Panel>
);

const PhysicalBreakPanel = ({
  state,
}: {
  readonly state: WalletRecoveryViewState;
}) => (
  <Panel aria-labelledby="physical-break-heading">
    <PanelHeader>
      <Kicker>Independent reading</Kicker>
      <Heading id="physical-break-heading">Move the DiceKey before scan 2</Heading>
      <Lead>
        Pick it up, rotate or reposition it, and settle it again. This physical break prevents the second reading from reusing the first camera attempt.
      </Lead>
    </PanelHeader>
    <Callout $tone="warning">
      Do not continue while the DiceKey and camera are still in the same position.
    </Callout>
    <ActionBar>
      <PrimaryButton onClick={state.acknowledgePhysicalBreak}>
        I moved it — start scan 2
      </PrimaryButton>
    </ActionBar>
  </Panel>
);

const describeFace = (face: RecoveryDiceKeyFace): string =>
  `${face.letter}${face.digit}, facing ${orientationLabels[face.orientationAsLowercaseLetterTrbl]}`;

const DifferenceRow = ({ difference }: { readonly difference: FaceDifference }) => (
  <DifferenceItem>
    <DifferenceNumber aria-hidden="true">{difference.position}</DifferenceNumber>
    <div>
      <strong>Row {difference.row}, column {difference.column}</strong>
      <div>{difference.fields.join(", ")} differ</div>
      <div>Scan 1: {describeFace(difference.firstScanFace)}</div>
      <div>Scan 2: {describeFace(difference.secondScanFace)}</div>
    </div>
  </DifferenceItem>
);

const MismatchPanel = ({
  state,
  flowState,
  onRestart,
}: {
  readonly state: WalletRecoveryViewState;
  readonly flowState: Extract<AcquisitionState, { readonly kind: "mismatch" }>;
  readonly onRestart: () => void;
}) => (
  <WidePanel aria-labelledby="mismatch-heading">
    <PanelHeader>
      <Kicker>Scans do not match</Kicker>
      <Heading id="mismatch-heading">Start again with two clean readings</Heading>
      <Lead>
        The closest physical alignment still contains {flowState.comparison.bestComparison.differences.length} differing {flowState.comparison.bestComparison.differences.length === 1 ? "face" : "faces"}. No recovery words were created.
      </Lead>
    </PanelHeader>
    <Callout $tone="danger" role="alert">
      There is no “use anyway” option. This ceremony fails closed when the two readings differ.
    </Callout>
    <DifferenceList aria-label="Differences between scans">
      {flowState.comparison.bestComparison.differences.map((difference) => (
        <DifferenceRow key={difference.position} difference={difference} />
      ))}
    </DifferenceList>
    <ActionBar>
      <PrimaryButton
        disabled={state.sessionGateStatus !== "idle"}
        onClick={onRestart}
      >
        Clear and scan both again
      </PrimaryButton>
    </ActionBar>
  </WidePanel>
);

const AmbiguousPanel = ({
  state,
  flowState,
  onRestart,
}: {
  readonly state: WalletRecoveryViewState;
  readonly flowState: Extract<AcquisitionState, { readonly kind: "alignment-ambiguous" }>;
  readonly onRestart: () => void;
}) => (
  <Panel aria-labelledby="ambiguous-heading">
    <PanelHeader>
      <Kicker>Alignment uncertain</Kicker>
      <Heading id="ambiguous-heading">The scanner cannot choose a rotation safely</Heading>
      <Lead>
        More than one physical alignment is equally plausible. No recovery words were created.
      </Lead>
    </PanelHeader>
    <Callout $tone="danger" role="alert">
      The app will not guess which orientation is correct.
    </Callout>
    <Stack aria-label="Equally plausible alignments">
      {flowState.comparison.tiedComparisons.map((comparison) => (
        <Callout key={comparison.rotation}>
          {comparison.rotation * 90}° clockwise — {comparison.differences.length} differing {comparison.differences.length === 1 ? "face" : "faces"}
        </Callout>
      ))}
    </Stack>
    <ActionBar>
      <PrimaryButton
        disabled={state.sessionGateStatus !== "idle"}
        onClick={onRestart}
      >
        Clear and scan both again
      </PrimaryButton>
    </ActionBar>
  </Panel>
);

const MatchedPanel = ({ state }: { readonly state: WalletRecoveryViewState }) => (
  <Panel aria-labelledby="matched-heading">
    <PanelHeader>
      <Kicker>Two readings confirmed</Kicker>
      <Heading id="matched-heading">The DiceKey scans match</Heading>
      <Lead>
        Both independent readings describe the same physical DiceKey. Recovery words have not been revealed yet.
      </Lead>
    </PanelHeader>
    <StatusMark $tone="success" aria-hidden="true">✓</StatusMark>
    <ActionBar>
      <PrimaryButton onClick={() => { void state.beginDerivation(); }}>
        Create recovery words locally
      </PrimaryButton>
    </ActionBar>
  </Panel>
);

export const WalletRecoveryAcquisitionView = observer(({
  state,
  onExit,
  onRestart,
}: WalletRecoveryAcquisitionViewProps) => {
  const flowState = state.flowState as AcquisitionState;
  switch (flowState.kind) {
    case "awaiting-first-acquisition":
    case "awaiting-second-acquisition":
      return <ScanPanel {...{ state, flowState, onExit, onRestart }} />;
    case "reviewing-first-acquisition":
    case "reviewing-second-acquisition":
      return <ReviewPanel {...{ state, flowState }} />;
    case "releasing-first-acquisition":
      return <ReleasingPanel scanNumber={1} />;
    case "awaiting-physical-break":
      return <PhysicalBreakPanel state={state} />;
    case "releasing-second-acquisition":
      return <ReleasingPanel scanNumber={2} />;
    case "matched":
      return <MatchedPanel state={state} />;
    case "mismatch":
      return <MismatchPanel state={state} flowState={flowState} onRestart={onRestart} />;
    case "alignment-ambiguous":
      return <AmbiguousPanel state={state} flowState={flowState} onRestart={onRestart} />;
  }
});
