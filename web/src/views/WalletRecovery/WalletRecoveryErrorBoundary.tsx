import React from "react";

import {
  ActionBar,
  BodyText,
  Callout,
  Heading,
  Kicker,
  Panel,
  PanelHeader,
  PrimaryButton,
  SecondaryButton,
  StatusMark,
} from "./WalletRecoveryStyles";

interface WalletRecoveryErrorBoundaryProps extends React.PropsWithChildren {
  readonly onClear: () => void;
  readonly onExit: () => void;
  readonly onRestart: () => void;
  readonly resetKey: object;
}

interface WalletRecoveryErrorBoundaryState {
  readonly failed: boolean;
}

/**
 * A payload-free final guard around the recovery ceremony. Error objects are
 * deliberately neither retained nor rendered, logged, or forwarded.
 */
export class WalletRecoveryErrorBoundary extends React.Component<
  WalletRecoveryErrorBoundaryProps,
  WalletRecoveryErrorBoundaryState
> {
  public state: WalletRecoveryErrorBoundaryState = { failed: false };

  private readonly headingRef = React.createRef<HTMLHeadingElement>();

  public static getDerivedStateFromError(): WalletRecoveryErrorBoundaryState {
    return { failed: true };
  }

  public componentDidCatch(): void {
    this.props.onClear();
    this.headingRef.current?.focus();
  }

  public componentDidUpdate(
    previousProps: Readonly<WalletRecoveryErrorBoundaryProps>,
  ): void {
    if (
      this.state.failed &&
      previousProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ failed: false });
    }
  }

  public render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Panel role="alert" aria-labelledby="wallet-recovery-ui-failure-heading">
        <PanelHeader>
          <Kicker>Recovery stopped safely</Kicker>
          <Heading
            id="wallet-recovery-ui-failure-heading"
            ref={this.headingRef}
            tabIndex={-1}
          >
            This recovery screen could not continue
          </Heading>
        </PanelHeader>
        <StatusMark $tone="danger" aria-hidden="true">!</StatusMark>
        <Callout $tone="danger">
          The active recovery ceremony was cleared. No recovery words can be produced from this failed screen.
        </Callout>
        <BodyText>
          Start a new ceremony or return to the DiceKeys home screen.
        </BodyText>
        <ActionBar>
          <SecondaryButton onClick={this.props.onExit}>Return home</SecondaryButton>
          <PrimaryButton onClick={this.props.onRestart}>Start again</PrimaryButton>
        </ActionBar>
      </Panel>
    );
  }
}
