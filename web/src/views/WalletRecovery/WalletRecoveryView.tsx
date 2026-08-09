import { observer } from "mobx-react";
import React, { useEffect, useRef, useState } from "react";

import ScanDiceKeyImage from "../../images/Scanning a DiceKey.svg";
import type { RecoveryFlowState } from "./foundation";
import { WalletRecoveryAcquisitionView } from "./WalletRecoveryAcquisitionView";
import { WalletRecoveryErrorBoundary } from "./WalletRecoveryErrorBoundary";
import {
  RecoveryMetadata,
  WalletRecoveryMaterialView,
} from "./WalletRecoveryMaterialView";
import {
  WalletRecoverySafeErrorCode,
  WalletRecoveryViewState,
} from "./WalletRecoveryViewState";
import {
  ActionBar,
  BodyText,
  Callout,
  CeremonyItem,
  CeremonyList,
  CeremonyRail,
  ConsentCheckbox,
  ConsentLabel,
  ConsentList,
  HeaderExitButton,
  HeaderEyebrow,
  HeaderIdentity,
  HeaderInner,
  HeaderTitle,
  Heading,
  Illustration,
  IndeterminateRule,
  Kicker,
  Lead,
  MobileProgress,
  MobileProgressStep,
  Panel,
  PanelHeader,
  PrimaryButton,
  RecoveryHeader,
  RecoveryLayout,
  RecoveryMain,
  RecoveryRoot,
  SafetyRail,
  SecondaryButton,
  SkipLink,
  Stack,
  StatusMark,
  StickyRailContent,
  VisuallyHidden,
} from "./WalletRecoveryStyles";

export interface WalletRecoveryViewProps {
  readonly state: WalletRecoveryViewState;
  readonly onExit: () => void;
  readonly onRestart: () => void;
}

const ceremonySteps = Object.freeze([
  "Prepare",
  "Scan twice",
  "Reveal",
  "Verify backup",
  "Finish",
]);

const activeStepForState = (state: RecoveryFlowState): number | undefined => {
  switch (state.kind) {
    case "explain":
      return 0;
    case "awaiting-first-acquisition":
    case "reviewing-first-acquisition":
    case "releasing-first-acquisition":
    case "awaiting-physical-break":
    case "awaiting-second-acquisition":
    case "reviewing-second-acquisition":
    case "releasing-second-acquisition":
    case "matched":
    case "mismatch":
    case "alignment-ambiguous":
    case "deriving":
      return 1;
    case "concealed":
    case "revealed":
      return 2;
    case "backup-choice":
    case "six-word-challenge":
    case "full-entry":
      return 3;
    case "verified":
      return 4;
    case "cleared":
    case "failed":
      return undefined;
  }
};

const screenIdentityForState = (
  state: RecoveryFlowState,
  safeErrorCode: WalletRecoverySafeErrorCode | undefined,
): string => {
  if (safeErrorCode != null) return `failed:${safeErrorCode}`;
  return state.kind === "failed" ? `failed:${state.code}` : state.kind;
};

const SessionCleanupGateCallout = observer(({
  state,
}: {
  readonly state: WalletRecoveryViewState;
}) => {
  switch (state.sessionGateStatus) {
    case "idle":
      return null;
    case "pending":
      return (
        <Callout $tone="warning" role="status" aria-live="polite">
          A previous scanner attempt is still cleaning up. Wait for cleanup confirmation before beginning another recovery ceremony.
        </Callout>
      );
    case "unconfirmed":
      return (
        <Callout $tone="danger" role="alert">
          Scanner cleanup could not be confirmed. Close and reload this page or app before attempting wallet recovery again.
        </Callout>
      );
  }
});

const ExplanationPanel = ({
  state,
  onExit,
}: {
  readonly state: WalletRecoveryViewState;
  readonly onExit: () => void;
}) => {
  const [computerIsOfflineAndTrusted, setComputerIsOfflineAndTrusted] =
    useState(false);
  const [understandsWordsControlWallet, setUnderstandsWordsControlWallet] =
    useState(false);
  const [willRetainProfileWithPhysicalDiceKey, setWillRetainProfileWithPhysicalDiceKey] =
    useState(false);
  const allConsentsGiven = computerIsOfflineAndTrusted &&
    understandsWordsControlWallet && willRetainProfileWithPhysicalDiceKey;

  return (
    <Panel aria-labelledby="recovery-explanation-heading">
      <PanelHeader>
        <Kicker>Offline recovery ceremony</Kicker>
        <Heading id="recovery-explanation-heading">
          Create Bitcoin wallet recovery words
        </Heading>
        <Lead>
          Two independent DiceKey readings create one stable set of 24 BIP39 English words. This tool does not create accounts, balances, addresses, or transactions.
        </Lead>
      </PanelHeader>
      <Illustration src={ScanDiceKeyImage} alt="A camera scanning a physical DiceKey" />
      <Callout $tone="danger">
        Anyone who sees the 24 words can control the wallet they recover. Use a private, trusted device with networking turned off.
      </Callout>
      <SessionCleanupGateCallout state={state} />
      {state.inlineErrorCode === "CONSENT_REQUIRED" ? (
        <Callout $tone="warning" role="alert">
          Confirm all three safety conditions before beginning the first scan.
        </Callout>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          state.acceptExplanation({
            computerIsOfflineAndTrusted,
            understandsWordsControlWallet,
            willRetainProfileWithPhysicalDiceKey,
          });
        }}
      >
        <ConsentList>
          <legend>Confirm all three conditions</legend>
          <ConsentLabel>
            <ConsentCheckbox
              type="checkbox"
              checked={computerIsOfflineAndTrusted}
              onChange={(event) => setComputerIsOfflineAndTrusted(event.currentTarget.checked)}
            />
            <span>This computer is trusted and I have turned networking off.</span>
          </ConsentLabel>
          <ConsentLabel>
            <ConsentCheckbox
              type="checkbox"
              checked={understandsWordsControlWallet}
              onChange={(event) => setUnderstandsWordsControlWallet(event.currentTarget.checked)}
            />
            <span>I understand that the 24 words can control the recovered wallet.</span>
          </ConsentLabel>
          <ConsentLabel>
            <ConsentCheckbox
              type="checkbox"
              checked={willRetainProfileWithPhysicalDiceKey}
              onChange={(event) => setWillRetainProfileWithPhysicalDiceKey(event.currentTarget.checked)}
            />
            <span>I will keep the profile name with my physical DiceKey and written backup.</span>
          </ConsentLabel>
        </ConsentList>
        <ActionBar>
          <SecondaryButton type="button" onClick={onExit}>Cancel</SecondaryButton>
          <PrimaryButton
            type="submit"
            disabled={!allConsentsGiven || !state.canBeginRecovery}
          >
            Begin scan 1
          </PrimaryButton>
        </ActionBar>
      </form>
    </Panel>
  );
};

const DerivingPanel = () => (
  <Panel role="status" aria-live="polite" aria-busy="true">
    <PanelHeader>
      <Kicker>Local derivation</Kicker>
      <Heading>Creating the recovery material</Heading>
      <Lead>
        Keep this screen open. The verified DiceKey is being converted to the frozen recovery profile locally.
      </Lead>
    </PanelHeader>
    <IndeterminateRule />
    <Callout>
      Nothing is being copied, printed, encoded as a QR code, or sent over a network.
    </Callout>
  </Panel>
);

const failureMessages: Readonly<Record<WalletRecoverySafeErrorCode, {
  readonly title: string;
  readonly message: string;
  readonly restartAllowed: boolean;
}>> = {
  INVALID_ACQUISITION: {
    title: "The scanner result was not valid",
    message: "The reading could not enter the wallet recovery flow. No recovery words were created.",
    restartAllowed: true,
  },
  ACQUISITION_REUSED: {
    title: "The second reading was not independent",
    message: "The same scanner attempt cannot be used twice. Start again with two distinct readings.",
    restartAllowed: true,
  },
  ACQUISITION_FAILED: {
    title: "The scanner attempt failed",
    message: "The camera reading ended before a safe candidate was available. No recovery words were created.",
    restartAllowed: true,
  },
  ACQUISITION_DISPOSAL_FAILED: {
    title: "Scanner cleanup could not be confirmed",
    message: "Scanner cleanup was attempted, but the app could not confirm that it completed. Close and reload this page or app before trying wallet recovery again.",
    restartAllowed: false,
  },
  DERIVATION_FAILED: {
    title: "Recovery-word creation failed",
    message: "The frozen recovery profile did not complete. No recovery words can be used from this attempt.",
    restartAllowed: true,
  },
  INVALID_DERIVATION_RESULT: {
    title: "The recovery result was rejected",
    message: "The result did not match the required 24-word shape and was not exposed.",
    restartAllowed: true,
  },
  CHECK_CODE_FAILED: {
    title: "The profile check code failed",
    message: "The comparison code could not be created, so the recovery material remains unusable.",
    restartAllowed: true,
  },
  INVALID_CHECK_CODE: {
    title: "The profile check code was rejected",
    message: "The comparison code did not match the frozen format. The recovery material was not exposed.",
    restartAllowed: true,
  },
  ILLEGAL_TRANSITION: {
    title: "That action is no longer available",
    message: "The recovery ceremony changed before the action completed. Start a fresh ceremony.",
    restartAllowed: true,
  },
  CONSENT_REQUIRED: {
    title: "All safety confirmations are required",
    message: "The recovery ceremony cannot begin until all three conditions are confirmed.",
    restartAllowed: true,
  },
  REVIEW_INCOMPLETE: {
    title: "The face review is incomplete",
    message: "Every flagged DiceKey face must be confirmed before the scanner can be released.",
    restartAllowed: true,
  },
  POSITION_NOT_REVIEWABLE: {
    title: "That face was not flagged for review",
    message: "Only scanner-flagged positions can be confirmed or corrected in this ceremony.",
    restartAllowed: true,
  },
  SECURE_RANDOM_UNAVAILABLE: {
    title: "Secure challenge selection is unavailable",
    message: "The six-position backup check could not be selected securely. Start again or use a supported runtime.",
    restartAllowed: true,
  },
  SCANNER_CALLBACK_INVALID: {
    title: "The scanner response was rejected",
    message: "The response was not correctly paired to this camera attempt. The ceremony was cleared.",
    restartAllowed: true,
  },
  SCANNER_SESSION_BLOCKED: {
    title: "A prior scanner session is still clearing",
    message: "This ceremony was cleared because a fresh scan cannot start until the renderer confirms cleanup of the prior attempt.",
    restartAllowed: false,
  },
  UNEXPECTED_UI_FAILURE: {
    title: "The recovery ceremony stopped safely",
    message: "An unexpected screen failure cleared the active ceremony. Any recovery material created or revealed during this ceremony is no longer available in the active flow.",
    restartAllowed: true,
  },
};

const FailurePanel = ({
  state,
  code,
  onExit,
  onRestart,
}: {
  readonly state: WalletRecoveryViewState;
  readonly code: WalletRecoverySafeErrorCode;
  readonly onExit: () => void;
  readonly onRestart: () => void;
}) => {
  const failure = failureMessages[code];
  return (
    <Panel role="alert" aria-labelledby="recovery-failure-heading">
      <PanelHeader>
        <Kicker>Recovery stopped safely</Kicker>
        <Heading id="recovery-failure-heading">{failure.title}</Heading>
        <Lead>{failure.message}</Lead>
      </PanelHeader>
      <StatusMark $tone="danger" aria-hidden="true">!</StatusMark>
      <Callout $tone="danger">
        Do not use partial material or continue from this failed ceremony.
      </Callout>
      <SessionCleanupGateCallout state={state} />
      <ActionBar>
        <SecondaryButton onClick={onExit}>Clear recovery data</SecondaryButton>
        {failure.restartAllowed && state.sessionGateStatus === "idle" ? (
          <PrimaryButton onClick={onRestart}>Start a fresh ceremony</PrimaryButton>
        ) : null}
      </ActionBar>
    </Panel>
  );
};

const ClearedPanel = ({ onExit }: { readonly onExit: () => void }) => (
  <Panel aria-labelledby="recovery-cleared-heading">
    <PanelHeader>
      <Kicker>Ceremony cleared</Kicker>
      <Heading id="recovery-cleared-heading">Recovery material is no longer available</Heading>
      <Lead>
        The active flow has dropped its DiceKey readings, recovery words, profile, and check-code references.
      </Lead>
    </PanelHeader>
    <StatusMark $tone="success" aria-hidden="true">✓</StatusMark>
    <BodyText>
      JavaScript strings cannot be perfectly erased from runtime memory, so this screen makes no stronger overwrite claim.
    </BodyText>
    <ActionBar>
      <PrimaryButton onClick={onExit}>Return home</PrimaryButton>
    </ActionBar>
  </Panel>
);

const RecoveryScreen = observer(({
  state,
  onExit,
  onReturnHome,
  onRestart,
}: WalletRecoveryViewProps & {
  readonly onReturnHome: () => void;
}) => {
  const flowState = state.flowState;
  const safeErrorCode = state.safeErrorCode;
  if (safeErrorCode != null) {
    return <FailurePanel state={state} code={safeErrorCode} {...{ onExit, onRestart }} />;
  }

  switch (flowState.kind) {
    case "explain":
      return <ExplanationPanel {...{ state, onExit }} />;
    case "awaiting-first-acquisition":
    case "reviewing-first-acquisition":
    case "releasing-first-acquisition":
    case "awaiting-physical-break":
    case "awaiting-second-acquisition":
    case "reviewing-second-acquisition":
    case "releasing-second-acquisition":
    case "matched":
    case "mismatch":
    case "alignment-ambiguous":
      return (
        <WalletRecoveryAcquisitionView
          {...{ state, onExit, onRestart }}
        />
      );
    case "deriving":
      return <DerivingPanel />;
    case "concealed":
    case "revealed":
    case "backup-choice":
    case "six-word-challenge":
    case "full-entry":
    case "verified":
      return <WalletRecoveryMaterialView {...{ state, onExit }} />;
    case "failed":
      return <FailurePanel state={state} code={flowState.code} {...{ onExit, onRestart }} />;
    case "cleared":
      return <ClearedPanel onExit={onReturnHome} />;
  }
});

const MetadataRail = ({ state }: { readonly state: RecoveryFlowState }) => {
  if (!("profileId" in state) || !("checkCode" in state)) {
    return (
      <Stack>
        <Callout>
          Keep networking off for the complete ceremony.
        </Callout>
        <BodyText>
          The app requires two distinct camera attempts before it can create recovery material.
        </BodyText>
      </Stack>
    );
  }
  return <RecoveryMetadata profileId={state.profileId} checkCode={state.checkCode} />;
};

const MountedRecoveryView = observer(({
  state,
  onExit,
  onRestart,
}: WalletRecoveryViewProps) => {
  useEffect(() => state.mountView(), [state]);
  const flowState = state.flowState;
  const safeErrorCode = state.safeErrorCode;
  const screenIdentity = screenIdentityForState(flowState, safeErrorCode);
  const activeStep = safeErrorCode == null
    ? activeStepForState(flowState)
    : undefined;
  const neutralProgressMessage = activeStep != null
    ? undefined
    : safeErrorCode != null || flowState.kind === "failed"
      ? "Recovery stopped. No ceremony step is active."
      : "Ceremony cleared. No recovery step is active.";
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const destination = mainRef.current?.querySelector<HTMLHeadingElement>("h1") ??
      mainRef.current;
    destination?.focus();
  }, [state, screenIdentity]);

  return (
    <>
      <SkipLink href="#wallet-recovery-main">Skip to recovery step</SkipLink>
      <RecoveryHeader>
        <HeaderInner>
          <HeaderIdentity>
            <HeaderEyebrow>DiceKeys · offline recovery</HeaderEyebrow>
            <HeaderTitle>Create wallet recovery words</HeaderTitle>
          </HeaderIdentity>
          <HeaderExitButton type="button" onClick={state.clear}>
            Exit and clear
          </HeaderExitButton>
        </HeaderInner>
        {activeStep == null ? null : (
          <MobileProgress aria-label={`Recovery step ${activeStep + 1} of ${ceremonySteps.length}`}>
            {ceremonySteps.map((label, index) => (
              <MobileProgressStep
                key={label}
                $active={index === activeStep}
                $complete={index < activeStep}
                aria-current={index === activeStep ? "step" : undefined}
              >
                <VisuallyHidden>Step {index + 1}: {label}</VisuallyHidden>
              </MobileProgressStep>
            ))}
          </MobileProgress>
        )}
      </RecoveryHeader>
      <RecoveryLayout>
        <CeremonyRail aria-label="Recovery ceremony progress">
          {activeStep == null ? (
            <BodyText>{neutralProgressMessage}</BodyText>
          ) : (
            <CeremonyList>
              {ceremonySteps.map((label, index) => (
                <CeremonyItem
                  key={label}
                  $active={index === activeStep}
                  $complete={index < activeStep}
                  aria-current={index === activeStep ? "step" : undefined}
                >
                  {label}
                </CeremonyItem>
              ))}
            </CeremonyList>
          )}
        </CeremonyRail>
        <RecoveryMain ref={mainRef} id="wallet-recovery-main" tabIndex={-1}>
          <RecoveryScreen
            state={state}
            onExit={state.clear}
            onReturnHome={onExit}
            onRestart={onRestart}
          />
        </RecoveryMain>
        <SafetyRail aria-label="Recovery safety and profile details">
          <StickyRailContent>
            <MetadataRail state={state.flowState} />
          </StickyRailContent>
        </SafetyRail>
      </RecoveryLayout>
    </>
  );
});

export const WalletRecoveryView = observer((props: WalletRecoveryViewProps) => {
  return (
    <RecoveryRoot>
      <WalletRecoveryErrorBoundary
        onClear={props.state.clear}
        onExit={props.onExit}
        onRestart={props.onRestart}
        resetKey={props.state}
      >
        <MountedRecoveryView
          {...props}
        />
      </WalletRecoveryErrorBoundary>
    </RecoveryRoot>
  );
});
