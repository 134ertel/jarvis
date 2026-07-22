import Layout from "./components/Layout";
import ErrorBoundary from "./components/ErrorBoundary";

export default function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <Layout />
    </ErrorBoundary>
  );
}
