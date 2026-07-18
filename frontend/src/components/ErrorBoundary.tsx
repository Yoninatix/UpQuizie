import { Component, ErrorInfo, ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="min-h-screen bg-surface p-8 text-on-surface">
        <section className="mx-auto max-w-xl rounded-xl border border-outline-variant bg-surface-container-lowest p-6 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-widest text-error">Something went wrong</p>
          <h1 className="mt-2 font-headline text-2xl font-bold text-primary">The page could not render.</h1>
          <p className="mt-3 text-sm text-on-surface-variant">
            Refresh the page, or go back and try the last action again.
          </p>
          <p className="mt-4 rounded-lg bg-surface-container-low p-3 font-mono text-xs text-on-surface-variant">
            {this.state.error.message}
          </p>
          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="rounded-lg border border-outline-variant px-4 py-2 text-sm font-semibold text-on-surface-variant"
            >
              Go back
            </button>
          </div>
        </section>
      </main>
    );
  }
}
