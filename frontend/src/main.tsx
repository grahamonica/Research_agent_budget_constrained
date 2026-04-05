/* Purpose: Bootstrap the minimal React application and mount the live research dashboard into the browser root. */

import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("React root element with id 'root' was not found.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
