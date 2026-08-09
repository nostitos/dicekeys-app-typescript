import { observer } from "mobx-react";
import React from "react";

import type {
  RecoveryFlowState,
  RecoveryWordEntry,
  RecoveryWordPosition,
} from "./foundation";
import { WalletRecoveryViewState } from "./WalletRecoveryViewState";
import {
  ActionBar,
  BodyText,
  Callout,
  ChoiceButton,
  ChoiceTitle,
  EntryGrid,
  Heading,
  InlineRecoveryMetadata,
  Kicker,
  Lead,
  MetadataCard,
  MetadataLabel,
  MetadataValue,
  Panel,
  PanelHeader,
  PrimaryButton,
  SealedMaterial,
  SecondaryButton,
  Split,
  Stack,
  StatusMark,
  Subheading,
  VisuallyHidden,
  WidePanel,
  WordCell,
  WordGrid,
  WordInput,
  WordInputLabel,
  WordNumber,
  WordText,
} from "./WalletRecoveryStyles";

interface WalletRecoveryMaterialViewProps {
  readonly state: WalletRecoveryViewState;
  readonly onExit: () => void;
}

type MaterialState = Extract<
  RecoveryFlowState,
  {
    readonly kind:
      | "concealed"
      | "revealed"
      | "backup-choice"
      | "six-word-challenge"
      | "full-entry"
      | "verified";
  }
>;

export const RecoveryMetadata = ({
  profileId,
  checkCode,
}: {
  readonly profileId: string;
  readonly checkCode: string;
}) => (
  <Stack $gap="0.65rem" aria-label="Recovery profile metadata">
    <MetadataCard>
      <MetadataLabel>Recovery profile</MetadataLabel>
      <MetadataValue>{profileId}</MetadataValue>
    </MetadataCard>
    <MetadataCard>
      <MetadataLabel>Recovery profile check code v1</MetadataLabel>
      <MetadataValue>{checkCode}</MetadataValue>
    </MetadataCard>
    <Callout $tone="warning">
      This deterministic code is only a comparison aid. It is linkable, not authentication, ownership proof, a wallet identifier, or a substitute for all 24 words.
    </Callout>
  </Stack>
);

const ConcealedPanel = ({
  state,
  flowState,
  onExit,
}: WalletRecoveryMaterialViewProps & {
  readonly flowState: Extract<MaterialState, { readonly kind: "concealed" }>;
}) => (
  <Panel aria-labelledby="concealed-heading">
    <PanelHeader>
      <Kicker>Recovery material ready</Kicker>
      <Heading id="concealed-heading">The 24 words are still concealed</Heading>
      <Lead>
        Reveal them only when no camera, screen sharing session, or other person can observe this display.
      </Lead>
    </PanelHeader>
    <Stack>
      <InlineRecoveryMetadata data-layout="inline-recovery-metadata">
        <RecoveryMetadata
          profileId={flowState.profileId}
          checkCode={flowState.checkCode}
        />
      </InlineRecoveryMetadata>
      <SealedMaterial>
        <Stack>
          <Subheading>24 numbered words are sealed</Subheading>
          <BodyText>
            Anyone who obtains them can control the wallet they recover.
          </BodyText>
        </Stack>
      </SealedMaterial>
    </Stack>
    <ActionBar>
      <SecondaryButton onClick={onExit}>Exit and clear</SecondaryButton>
      <PrimaryButton onClick={state.reveal}>Reveal 24 recovery words</PrimaryButton>
    </ActionBar>
  </Panel>
);

const RevealedPanel = ({
  state,
  flowState,
  onExit,
}: WalletRecoveryMaterialViewProps & {
  readonly flowState: Extract<MaterialState, { readonly kind: "revealed" }>;
}) => (
  <WidePanel aria-labelledby="revealed-heading">
    <PanelHeader>
      <Kicker>Write down every word</Kicker>
      <Heading id="revealed-heading">Your 24 recovery words</Heading>
      <Lead>
        Copy the words by number onto an offline backup. This screen has no clipboard, QR, print, or network export.
      </Lead>
    </PanelHeader>
    <Callout $tone="danger" role="alert">
      Never photograph, upload, message, or paste these words into another device.
    </Callout>
    <WordGrid aria-label="Numbered wallet recovery words">
      {flowState.wordEntries.map(({ position, word }) => (
        <WordCell key={position}>
          <WordNumber aria-hidden="true">{position}</WordNumber>
          <VisuallyHidden>Word {position}: </VisuallyHidden>
          <WordText>{word}</WordText>
        </WordCell>
      ))}
    </WordGrid>
    <InlineRecoveryMetadata data-layout="inline-recovery-metadata">
      <RecoveryMetadata
        profileId={flowState.profileId}
        checkCode={flowState.checkCode}
      />
    </InlineRecoveryMetadata>
    <ActionBar>
      <SecondaryButton onClick={onExit}>Exit and clear</SecondaryButton>
      <PrimaryButton onClick={state.continueToBackupChoice}>
        I wrote down all 24 words
      </PrimaryButton>
    </ActionBar>
  </WidePanel>
);

const BackupChoicePanel = ({
  state,
  flowState,
}: {
  readonly state: WalletRecoveryViewState;
  readonly flowState: Extract<MaterialState, { readonly kind: "backup-choice" }>;
}) => (
  <Panel aria-labelledby="backup-choice-heading">
    <PanelHeader>
      <Kicker>Verify the backup</Kicker>
      <Heading id="backup-choice-heading">Check what you wrote down</Heading>
      <Lead>
        Choose a local verification method. Neither method stores or transmits what you enter.
      </Lead>
    </PanelHeader>
    {state.inlineErrorCode === "SECURE_RANDOM_UNAVAILABLE" ? (
      <Callout $tone="warning" role="alert">
        Secure random selection is unavailable in this renderer. The six-position check is disabled, but you can still verify the backup by entering all 24 words.
      </Callout>
    ) : null}
    <Split>
      <ChoiceButton
        type="button"
        disabled={state.inlineErrorCode === "SECURE_RANDOM_UNAVAILABLE"}
        onClick={() => state.chooseBackupVerification("six-word-challenge")}
      >
        <ChoiceTitle>Six random positions</ChoiceTitle>
        <span>Recommended. Enter six unpredictably selected words from your written backup.</span>
      </ChoiceButton>
      <ChoiceButton
        type="button"
        onClick={() => state.chooseBackupVerification("full-entry")}
      >
        <ChoiceTitle>All 24 positions</ChoiceTitle>
        <span>Enter the complete backup for a full position-by-position check.</span>
      </ChoiceButton>
    </Split>
    <InlineRecoveryMetadata data-layout="inline-recovery-metadata">
      <RecoveryMetadata
        profileId={flowState.profileId}
        checkCode={flowState.checkCode}
      />
    </InlineRecoveryMetadata>
  </Panel>
);

const feedbackMessage = (
  feedbackCode: Extract<
    MaterialState,
    { readonly kind: "six-word-challenge" | "full-entry" }
  >["feedbackCode"],
): string | undefined => {
  switch (feedbackCode) {
    case "BACKUP_ENTRY_INCOMPLETE":
      return "Enter every requested position before checking the backup.";
    case "BACKUP_WORD_MISMATCH":
      return "At least one entered word does not match its numbered position. Check the written backup and try again.";
    case undefined:
      return undefined;
  }
};

const wordEntriesFromForm = (
  form: HTMLFormElement,
  positions: readonly RecoveryWordPosition[],
): readonly RecoveryWordEntry[] => {
  const formData = new FormData(form);
  return positions.map((position) => Object.freeze({
    position,
    word: String(formData.get(`word-${position}`) ?? ""),
  }));
};

const BackupEntryForm = ({
  positions,
  compact,
  feedbackCode,
  submitLabel,
  onSubmit,
  onBack,
}: {
  readonly positions: readonly RecoveryWordPosition[];
  readonly compact: boolean;
  readonly feedbackCode?: "BACKUP_WORD_MISMATCH" | "BACKUP_ENTRY_INCOMPLETE";
  readonly submitLabel: string;
  readonly onSubmit: (entries: readonly RecoveryWordEntry[]) => void;
  readonly onBack: () => void;
}) => {
  const feedback = feedbackMessage(feedbackCode);
  return (
    <form
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(wordEntriesFromForm(event.currentTarget, positions));
      }}
    >
      <Stack>
        {feedback == null ? null : (
          <Callout $tone="danger" role="alert" aria-live="assertive">
            {feedback}
          </Callout>
        )}
        <EntryGrid $compact={compact}>
          {positions.map((position, index) => (
            <WordInputLabel key={position}>
              <span aria-hidden="true">{position}</span>
              <VisuallyHidden>Word {position}</VisuallyHidden>
              <WordInput
                name={`word-${position}`}
                aria-label={`Recovery word ${position}`}
                inputMode="text"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint={index === positions.length - 1 ? "done" : "next"}
                placeholder="word"
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.nativeEvent.isComposing ||
                    index === positions.length - 1
                  ) return;
                  event.preventDefault();
                  const nextPosition = positions[index + 1];
                  if (nextPosition == null) return;
                  const nextInput = event.currentTarget.form?.elements.namedItem(
                    `word-${nextPosition}`,
                  );
                  if (nextInput instanceof HTMLElement) nextInput.focus();
                }}
              />
            </WordInputLabel>
          ))}
        </EntryGrid>
      </Stack>
      <ActionBar>
        <SecondaryButton type="button" onClick={onBack}>Choose another method</SecondaryButton>
        <PrimaryButton type="submit">{submitLabel}</PrimaryButton>
      </ActionBar>
    </form>
  );
};

const ChallengePanel = ({
  state,
  flowState,
}: {
  readonly state: WalletRecoveryViewState;
  readonly flowState: Extract<MaterialState, { readonly kind: "six-word-challenge" }>;
}) => (
  <Panel aria-labelledby="challenge-heading">
    <PanelHeader>
      <Kicker>Six-position check</Kicker>
      <Heading id="challenge-heading">Enter the requested words</Heading>
      <Lead>
        Read these numbered positions from the backup you just made. The expected words are never shown as hints.
      </Lead>
    </PanelHeader>
    <BackupEntryForm
      positions={flowState.positions}
      compact={true}
      feedbackCode={flowState.feedbackCode}
      submitLabel="Check six words"
      onBack={state.returnToBackupChoice}
      onSubmit={state.submitSixWordChallenge}
    />
  </Panel>
);

const allRecoveryWordPositions = Object.freeze(
  Array.from({ length: 24 }, (_, index) => index + 1 as RecoveryWordPosition),
);

const FullEntryPanel = ({
  state,
  flowState,
}: {
  readonly state: WalletRecoveryViewState;
  readonly flowState: Extract<MaterialState, { readonly kind: "full-entry" }>;
}) => (
  <WidePanel aria-labelledby="full-entry-heading">
    <PanelHeader>
      <Kicker>Full backup check</Kicker>
      <Heading id="full-entry-heading">Enter all 24 words by position</Heading>
      <Lead>
        Use only the written backup. This entry stays in the current recovery ceremony and is not persisted.
      </Lead>
    </PanelHeader>
    <BackupEntryForm
      positions={allRecoveryWordPositions}
      compact={false}
      feedbackCode={flowState.feedbackCode}
      submitLabel="Check all 24 words"
      onBack={state.returnToBackupChoice}
      onSubmit={state.submitFullEntry}
    />
  </WidePanel>
);

const VerifiedPanel = ({
  flowState,
  onExit,
}: {
  readonly flowState: Extract<MaterialState, { readonly kind: "verified" }>;
  readonly onExit: () => void;
}) => (
  <Panel aria-labelledby="verified-heading">
    <PanelHeader>
      <Kicker>Backup verified</Kicker>
      <Heading id="verified-heading">Your written recovery backup passed</Heading>
      <Lead>
        The app no longer retains the 24-word list in the active flow. Finish to clear the remaining recovery metadata, review the erasure caveat, and then return home.
      </Lead>
    </PanelHeader>
    <StatusMark $tone="success" aria-hidden="true">✓</StatusMark>
    <Callout $tone="success" role="status">
      Verified using {flowState.method === "six-word-challenge" ? "six random positions" : "all 24 positions"}.
    </Callout>
    <InlineRecoveryMetadata data-layout="inline-recovery-metadata">
      <RecoveryMetadata
        profileId={flowState.profileId}
        checkCode={flowState.checkCode}
      />
    </InlineRecoveryMetadata>
    <ActionBar>
      <PrimaryButton onClick={onExit}>Clear recovery data and finish</PrimaryButton>
    </ActionBar>
  </Panel>
);

export const WalletRecoveryMaterialView = observer(({
  state,
  onExit,
}: WalletRecoveryMaterialViewProps) => {
  const flowState = state.flowState as MaterialState;
  switch (flowState.kind) {
    case "concealed":
      return <ConcealedPanel {...{ state, flowState, onExit }} />;
    case "revealed":
      return <RevealedPanel {...{ state, flowState, onExit }} />;
    case "backup-choice":
      return <BackupChoicePanel {...{ state, flowState }} />;
    case "six-word-challenge":
      return <ChallengePanel {...{ state, flowState }} />;
    case "full-entry":
      return <FullEntryPanel {...{ state, flowState }} />;
    case "verified":
      return <VerifiedPanel {...{ flowState, onExit }} />;
  }
});
