import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("#root not found");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
