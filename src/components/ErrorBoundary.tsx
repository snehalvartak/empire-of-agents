import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Uncaught render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#15100a] p-6">
          <div className="max-w-md rounded-2xl border border-red-800/50 bg-[#1c1610] p-6">
            <h1 className="font-serif text-xl font-bold text-red-300">The empire has fallen silent</h1>
            <p className="mt-2 text-sm text-amber-100/60">{this.state.error.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg border border-amber-600/60 bg-amber-600/90 px-4 py-2 text-sm font-bold text-[#1a140d] hover:bg-amber-500"
            >
              Reload
              </button>
          </div>
          </div>
      );
    }
    return this.props.children;
  }
}
