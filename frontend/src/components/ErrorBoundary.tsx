import { Component, type ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Log so a stack is visible in browser devtools
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught:', error, info)
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-full flex items-center justify-center p-6 bg-slate-50">
          <div className="max-w-lg rounded-lg border border-rose-200 bg-rose-50 p-6 text-rose-800">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold">Something went wrong.</div>
                <pre className="text-xs mt-2 whitespace-pre-wrap text-rose-700">
                  {this.state.error.message}
                </pre>
                <button
                  className="mt-3 px-3 py-1.5 text-sm bg-white border border-rose-300 rounded hover:bg-rose-100"
                  onClick={this.reset}
                >
                  Try again
                </button>
              </div>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
