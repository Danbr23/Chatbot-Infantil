// src/App.jsx
import React from "react";
import { useAuth } from "react-oidc-context";
import Dashboard from "./pages/Dashboard";
import { logoutUrl } from "./config/auth";
import "./App.css";

const LockIcon = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
);
const SpinnerIcon = () => (
  <svg className="spinner-animate" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
);

function App() {
  const auth = useAuth();

  const handleLogout = () => {
    auth.removeUser();
    auth.revokeTokens();
    auth.clearStaleState();
    auth.signinSilent();
    window.location.href = logoutUrl(import.meta.env.VITE_APP_URI);
  };

  if (auth.isLoading) {
    return (
      <div className="app-container center-screen">
        <div className="glass-card loading-card">
          <SpinnerIcon />
          <p>Iniciando sistema...</p>
        </div>
      </div>
    );
  }

  if (auth.error) {
    return (
      <div className="app-container center-screen">
        <div className="glass-card error-card">
          <h3>Acesso Negado</h3>
          <p>{auth.error.message}</p>
          <button className="btn-secondary" onClick={() => window.location.reload()}>Tentar Novamente</button>
        </div>
      </div>
    );
  }

  if (auth.isAuthenticated) {
    return <Dashboard user={auth.user} onLogout={handleLogout} />;
  }

  return (
    <div className="app-container center-screen">
      {/* Fundo limpo, sem blobs */}
      <div className="glass-card login-card fade-in">
        <div className="icon-circle">
          <LockIcon />
        </div>

        <h1 className="login-title">Brinquedo ADM</h1>
        <p className="login-subtitle">Painel de Controle Administrativo</p>

        <div className="divider"></div>

        <button className="btn-login-gradient" onClick={() => auth.signinRedirect()}>
          Acessar Painel Seguro
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 8 }}><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </button>

        <p className="footer-version">Ambiente Protegido v1.0</p>
      </div>
    </div>
  );
}

export default App;