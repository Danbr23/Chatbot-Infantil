// src/main.jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { AuthProvider } from "react-oidc-context";
import App from './App'
import { cognitoConfig } from './config/auth'; // Aquela config que criamos antes
import './App.css' // Seus estilos globais

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* O AuthProvider envolve todo o App para que o user fique disponível em qualquer lugar */}
    <AuthProvider {...cognitoConfig}>
      <App />
    </AuthProvider>
  </React.StrictMode>,
)