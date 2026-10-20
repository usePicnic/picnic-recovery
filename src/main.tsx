import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import { WalletProvider } from "./components/WalletProvider";

createRoot(document.getElementById("root")!).render(<React.StrictMode><WalletProvider><App /></WalletProvider></React.StrictMode>);
