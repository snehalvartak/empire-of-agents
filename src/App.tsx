import ErrorBoundary from '@/components/ErrorBoundary';
import WorldApp from '@/components/WorldApp';

function App() {
  return (
    <ErrorBoundary>
      <WorldApp />
    </ErrorBoundary>
  );
}

export default App;
