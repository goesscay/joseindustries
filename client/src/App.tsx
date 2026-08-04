import { useEffect, useState } from "react";

type HealthResponse = {
  status: string;
};

function App() {
  const [apiStatus, setApiStatus] = useState<string>("checking...");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<HealthResponse>)
      .then((data) => setApiStatus(data.status))
      .catch(() => setApiStatus("unreachable"));
  }, []);

  return (
    <div className="app">
      <h1>Jose Industries</h1>
      <p>API status: {apiStatus}</p>
    </div>
  );
}

export default App;
