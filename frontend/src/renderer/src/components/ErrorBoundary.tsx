import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors anywhere below it so a bug in one view
 * doesn't blank the entire app — shows a recoverable message instead. Does
 * NOT catch errors in event handlers or async code (React error boundaries
 * never do); those are handled locally by each view's own try/catch around
 * its fetch calls.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleReload = (): void => {
    this.setState({ error: null });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="placeholder-view glass-panel">
          <div className="placeholder-ring" />
          <h2>Something went wrong</h2>
          <p>JARVIS hit an unexpected error and couldn't continue. Reloading should fix it.</p>
          <button type="button" className="automation-new-button" onClick={this.handleReload}>
            Reload JARVIS
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
